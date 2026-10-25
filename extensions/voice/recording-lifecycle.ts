import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { VoiceConfig } from "./config.ts";
import {
	SAMPLE_RATE,
	CHANNELS,
	type LocalSession,
	type LocalSessionResult,
	type startLocalSession,
	type stopLocalSession,
} from "./local.ts";
import { createPreviewSession, type PreviewSession } from "./preview-session.ts";
import { createPreviewPanel } from "./preview-panel.ts";
import { startRecordingEntry, type RecordingEntryDeps } from "./recording-entry.ts";
import type { createRecordingOwner } from "./preview-entrypoint.ts";
import type { RecordingController, VoiceState } from "./recording-controller.ts";
import type { RenderTicker } from "./ui-render-ticker.ts";
import { classifyOutcome, deliverOutcome } from "./dictation-outcome.ts";
import { insertTranscript } from "./editor-sink.ts";
import { decideRecordingStartTimer } from "./hold-to-talk.ts";

export type RecordingContext = {
	hasUI: boolean;
	ui: Pick<ExtensionContext["ui"], "setWidget" | "notify" | "getEditorText" | "pasteToEditor" | "setEditorText">;
};

/** Borrow shared slots used by command cancellation and session cleanup; never copy their values. */
export interface RecordingLifecycleState {
	readonly config: VoiceConfig;
	readonly ctx: RecordingContext | null;
	activeSession: LocalSession | null;
	activePreview: PreviewSession | null;
	recordingOwner: ReturnType<typeof createRecordingOwner> | null;
	statusTimer: ReturnType<typeof setInterval> | null;
	lastStopTime: number;
	readonly recordingStart: number;
	readonly kittyReleaseDetected: boolean;
	readonly spaceDownTime: number | null;
}

export interface RecordingLifecycleDeps {
	state: RecordingLifecycleState;
	entry: RecordingEntryDeps<RecordingContext | null>;
	recordingController: RecordingController;
	voiceDebug(message: string, ...details: unknown[]): void;
	setVoiceState(state: VoiceState): void;
	clearRecordingAnimTimer(): void;
	clearWarmupWidget(): void;
	hideWidget(): void;
	showRecordingWidget(): void;
	playSound(kind: "start" | "stop" | "error"): void;
	resetHoldState(options?: { cooldown?: number }): void;
	cancelDelayedStop(): void;
	resetReleaseDetect(): void;
	updateAudioLevel(chunk: Buffer): void;
	updateVoiceStatus(): void;
	punctuateTranscript(text: string): string;
	addToHistory(text: string, duration: number, mode: "hold"): void;
	finishPreview(preview: PreviewSession): Promise<void>;
	detectAudioCaptureTool(): { cmd: string; args: string[]; name: string } | null;
	spawn(command: string, args: string[], options: SpawnOptions): ChildProcess;
	startLocalSession: typeof startLocalSession;
	stopLocalSession: typeof stopLocalSession;
	finalModels(): { id: string; name: string }[];
	now(): number;
	setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval>;
	clearInterval(timer: ReturnType<typeof setInterval>): void;
	getOrInitVoiceUi(): { ticker: Pick<RenderTicker, "subscribe"> };
}

/** Capture, preview and final delivery are composed here, with external effects injected. */
export function createRecordingLifecycle(deps: RecordingLifecycleDeps) {
	const {
		state: s,
		recordingController,
		voiceDebug,
		setVoiceState,
		clearRecordingAnimTimer,
		clearWarmupWidget,
		hideWidget,
		showRecordingWidget,
		playSound,
		resetHoldState,
		cancelDelayedStop,
		resetReleaseDetect,
		updateAudioLevel,
		updateVoiceStatus,
		punctuateTranscript,
		addToHistory,
		finishPreview,
		detectAudioCaptureTool,
		spawn,
		startLocalSession,
		stopLocalSession,
		finalModels,
		now,
		setInterval,
		clearInterval,
		getOrInitVoiceUi,
	} = deps;
	async function startRecording(): Promise<boolean> {
		const {
			generation,
			current,
			owner,
			recordingCtx,
			client: recordingPreviewClient,
		} = startRecordingEntry(deps.entry);
		let unsubscribe: (() => void) | undefined;
		let dirty = false;
		const channel = recordingPreviewClient.claim(String(generation), (event) => {
			if (!current()) return;
			preview.handleEvent(event);
			dirty = true;
		});
		const preview = createPreviewSession(channel, {
			mountPanel: (getText) => {
				if (!current() || !recordingCtx?.hasUI) return;
				recordingCtx.ui.setWidget(
					"voice-preview",
					(tui) => {
						const panel = createPreviewPanel(getText);
						if (!current()) return panel;
						tui.requestRender();
						unsubscribe = getOrInitVoiceUi().ticker.subscribe({
							tick: () => {
								if (current() && dirty) {
									dirty = false;
									tui.requestRender();
								}
							},
							label: "voice-preview",
						});
						return panel;
					},
					{ placement: "aboveEditor" }
				);
			},
			unmountPanel: () => {
				unsubscribe?.();
				if (current() && recordingCtx?.hasUI) recordingCtx.ui.setWidget("voice-preview", undefined);
			},
			onDegraded: (reason) => voiceDebug("preview degraded", { reason }),
		});
		s.activePreview = preview;
		const recordingCallbacks = {
			onAudioChunk: (chunk: Buffer) => {
				if (current() && (s.config.previewEnabled ?? true)) preview.feed(chunk);
			},
			onDone: (result: LocalSessionResult, doneMeta: { capturedBytes: number }) => {
				if (result.kind === "capture-failed") {
					recordingCallbacks.onError(result.message);
					return;
				}
				if (!owner.deliver()) return;
				const previewText = preview.terminal();
				s.activeSession = null;
				clearRecordingAnimTimer();
				if (s.statusTimer) {
					clearInterval(s.statusTimer);
					s.statusTimer = null;
				}
				s.lastStopTime = now();

				hideWidget();

				// PCM duration excludes time spent waiting for the final pass.
				const duration = doneMeta.capturedBytes / (SAMPLE_RATE * CHANNELS * 2);

				try {
					deliverOutcome(
						classifyOutcome({
							capturedBytes: doneMeta.capturedBytes,
							finalText: result.kind === "ok" ? result.text : null,
							finalHadSpeech: result.kind === "ok" && result.hadSpeech,
							previewText,
						}),
						preview.degraded,
						{
							hasUI: Boolean(s.ctx?.hasUI),
							// This existing stage owns cleanup plus punctuation and their diagnostics.
							clean: (text) => text,
							punctuate: punctuateTranscript,
							addToHistory: (text) => addToHistory(text, duration, "hold"),
							insert: (text) =>
								insertTranscript(
									{
										hasUI: Boolean(s.ctx?.hasUI),
										getEditorText: () => s.ctx!.ui.getEditorText(),
										pasteToEditor: (value) => s.ctx!.ui.pasteToEditor(value),
										setEditorText: (value) => s.ctx!.ui.setEditorText(value),
										debug: voiceDebug,
									},
									text
								),
							notify: (message, level) => s.ctx?.ui.notify(message, level),
						}
					);
				} catch (err) {
					voiceDebug("outcome delivery threw", { error: String(err) });
				} finally {
					void finishPreview(preview);
				}
				playSound("stop");
				// Full state reset on successful completion
				resetHoldState();
				// R24: the last call of the callback is a UI render via setVoiceState —
				// swallow it so the float promise cannot reject after the tail.
				try {
					setVoiceState("idle");
				} catch (err) {
					voiceDebug("idle transition threw", { error: String(err) });
				}
			},
			onError: (err: string) => {
				if (!owner.deliver()) return;
				preview.abort();
				s.activeSession = null;
				clearRecordingAnimTimer();
				if (s.statusTimer) {
					clearInterval(s.statusTimer);
					s.statusTimer = null;
				}
				hideWidget();

				// ── STOP THE LOOP ──
				// On error, fully reset ALL hold state AND set a cooldown
				// so incoming key-repeat events can't re-trigger activation.
				resetHoldState({ cooldown: 5000 });
				clearWarmupWidget();

				s.ctx?.ui.notify(`Voice error: ${err}`, "error");
				playSound("error");
				setVoiceState("idle");
			},
		};

		// ── Start the local capture session ──
		const audioTool = detectAudioCaptureTool();
		if (!audioTool) {
			recordingCallbacks.onError("No audio capture tool found. Install one of: sox, ffmpeg, or arecord (Linux)");
			resetHoldState();
			setVoiceState("idle");
			return false;
		}
		const recProc = spawn(audioTool.cmd, audioTool.args, { stdio: ["pipe", "pipe", "pipe"] });
		recProc.stderr?.on("data", (d: Buffer) => {
			const msg = d.toString().trim();
			if (msg.includes("buffer overrun") || msg.includes("Discarding") || msg.includes("Last message repeated")) return;
			voiceDebug(`${audioTool.name} stderr:`, msg);
		});
		// Audio is buffered locally; transcription runs on stop.
		const session = startLocalSession(recProc, recordingCallbacks);

		// Feed audio level meter for waveform animation
		recProc.stdout?.on("data", (chunk: Buffer) => {
			if (current()) updateAudioLevel(chunk);
		});

		s.activeSession = session;

		// Status timer for elapsed time
		s.statusTimer = setInterval(() => {
			if (current() && recordingController.state === "recording") {
				updateVoiceStatus();
				const elapsed = (now() - s.recordingStart) / 1000;
				// The recording budget is configurable (`voice.maxRecordingSeconds`, default 120 s).
				if (elapsed >= (s.config.maxRecordingSeconds ?? 120)) {
					stopVoiceRecording();
				}
			}
		}, 1000);

		showRecordingWidget();
		playSound("start");

		// #13: arm the gap-based release timer only once recording is ready
		// (recordingController.state flipped to recording, success exit). Only hold sessions
		// (s.spaceDownTime != null — the user is holding SPACE) and non-Kitty
		// terminals arm: holding re-arms on each repeat, and release (repeat
		// stream stops) is perceived within RELEASE_DETECT_RECORDING_MS, so a
		// key-up inside the startup window also stops ~250ms later. Toggle/
		// dictation have no repeat stream keeping the timer alive — arming
		// would auto-stop recording ~250ms after start — so they must be
		// excluded (s.spaceDownTime == null). Kitty relies on the real key-release
		// event, so it stays clear.
		if (
			decideRecordingStartTimer({ kittyReleaseDetected: s.kittyReleaseDetected, isHold: s.spaceDownTime != null }) ===
			"arm"
		) {
			resetReleaseDetect();
		}
		return true;
	}

	async function stopVoiceRecording() {
		cancelDelayedStop(); // Safety: clear any pending delayed stop
		voiceDebug("stopVoiceRecording called", {
			voiceState: recordingController.state,
			hasActiveSession: !!s.activeSession,
		});
		if (recordingController.state !== "recording" || !s.ctx) return;
		if (s.statusTimer) {
			clearInterval(s.statusTimer);
			s.statusTimer = null;
		}

		if (s.activeSession) {
			setVoiceState("finalizing");
			clearRecordingAnimTimer();
			hideWidget();
			// Show which model is transcribing + estimated time
			const modelName =
				finalModels().find((m) => m.id === (s.config.localModel || "whisper-small"))?.name ||
				s.config.localModel ||
				"local model";
			s.ctx?.ui.notify(`Transcribing with ${modelName}…`, "info");
			const session = s.activeSession;
			const preview = s.activePreview;
			await s.recordingOwner?.stop(
				() => stopLocalSession(session, s.config),
				() => (preview ? preview.drain() : Promise.resolve())
			);
		} else {
			// No active session — shouldn't happen, but recover gracefully
			voiceDebug("stopVoiceRecording: no active session, resetting to idle");
			hideWidget();
			setVoiceState("idle");
		}
	}

	return { startRecording, stopVoiceRecording };
}
