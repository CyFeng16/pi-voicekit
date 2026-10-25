import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
	createRecordingLifecycle,
	type RecordingLifecycleState,
	type RecordingLifecycleDeps,
} from "../extensions/voice/recording-lifecycle";
import { createRecordingController } from "../extensions/voice/recording-controller";
import { createRecordingPresenter } from "../extensions/voice/recording-presenter";
import { createRecordingOwner, resolvePreviewModelDir } from "../extensions/voice/preview-entrypoint";
import { createPreviewClient, type PreviewClient } from "../extensions/voice/preview-worker-client";
import { createPreviewRetirement } from "../extensions/voice/preview-retirement";
import { makeWidgetRegistry } from "../extensions/voice/ui-widget-base";
import { startLocalSession, stopLocalSession, abortLocalSession } from "../extensions/voice/local";
import { DEFAULT_CONFIG } from "../extensions/voice/config";

export function lifecycleHarness(options: { failed?: boolean; missing?: boolean; captureAvailable?: boolean } = {}) {
	const events: string[] = [],
		writes: string[] = [],
		history: string[] = [],
		notices: string[] = [];
	const workers: EventEmitter[] = [];
	let flushes = 0;
	const process = Object.assign(new EventEmitter(), {
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
		kill() {},
	});
	const controller = createRecordingController({ debug() {} });
	const state: RecordingLifecycleState = {
		config: { ...DEFAULT_CONFIG, previewEnabled: true, localModel: "test" },
		ctx: {
			hasUI: true,
			ui: {
				notify: (text) => notices.push(text),
				getEditorText: () => "",
				pasteToEditor: (text) => {
					events.push("insert");
					writes.push(text);
				},
				setEditorText: () => {
					throw new Error("replacement");
				},
				setWidget: (key, widget) => {
					if (key === "voice-preview") events.push(widget ? "panel:mount" : "panel:unmount");
				},
			},
		},
		activeSession: null,
		activePreview: null,
		recordingOwner: null,
		statusTimer: null,
		lastStopTime: 0,
		recordingStart: 0,
		kittyReleaseDetected: false,
		spaceDownTime: null,
	};
	let client: PreviewClient | null = null;
	let modelDir: string | null = null;
	const retirement = createPreviewRetirement({ debug() {}, safeErrorText: String, setTimeout, clearTimeout });
	const setState: RecordingLifecycleDeps["setVoiceState"] = (value) => {
		controller.setState(value);
		events.push(`state:${value}`);
	};
	const presenter = createRecordingPresenter({
		registry: () => registry,
		hasUI: () => true,
		now: () => 0,
		getHoldThresholdMs: () => 1200,
		getRecordingStart: () => 0,
		setWidget(_key, widget) {
			if (widget) events.push("mount");
		},
		schedule: () => () => {},
		setState,
		notify: (message) => notices.push(message),
		playSound: (kind) => {
			events.push(`sound:${kind}`);
		},
		debug() {},
	});
	const registry = makeWidgetRegistry();
	const deps: RecordingLifecycleDeps = {
		state,
		recordingController: controller,
		entry: {
			recordingController: controller,
			debug() {},
			setState,
			getContext: () => state.ctx,
			getConfig: () => state.config,
			abortPreview: () => state.activePreview?.abort(),
			setOwner: (owner) => {
				state.recordingOwner = owner;
			},
			resolvePreviewModelDir: (enabled) =>
				resolvePreviewModelDir(
					enabled,
					() => !options.missing,
					() => "model"
				),
			createRecordingOwner,
			createPreviewClient: (options) =>
				createPreviewClient({
					...options,
					spawnWorker: () => {
						const worker = Object.assign(new EventEmitter(), {
							postMessage(message: { type: string }) {
								if (message.type === "flush") flushes++;
							},
							terminate() {},
						});
						workers.push(worker);
						return worker;
					},
				}),
			retirePreviewClient: retirement.retirePreviewClient,
			preview: {
				get client() {
					return client;
				},
				set client(value) {
					client = value;
				},
				get modelDir() {
					return modelDir;
				},
				set modelDir(value) {
					modelDir = value;
				},
				get finish() {
					return retirement.finish;
				},
				set finish(value) {
					retirement.finish = value;
				},
			},
		},
		voiceDebug() {},
		setVoiceState: setState,
		clearRecordingAnimTimer: presenter.stopRecordingAnimation,
		clearWarmupWidget: presenter.stopWarmupAnimation,
		hideWidget: presenter.hideIndicator,
		showRecordingWidget: presenter.mountRecordingIndicator,
		playSound: presenter.playSound,
		resetHoldState() {},
		cancelDelayedStop() {},
		resetReleaseDetect() {},
		updateAudioLevel() {},
		updateVoiceStatus() {},
		punctuateTranscript: (text) => text,
		addToHistory: (text) => {
			history.push(text);
		},
		finishPreview: retirement.finishPreview,
		detectAudioCaptureTool: () => {
			events.push("capture-detect");
			return options.captureAvailable === false ? null : { cmd: "fake", args: [], name: "sox" };
		},
		spawn: () => {
			events.push("capture-start");
			return process as unknown as ChildProcess;
		},
		startLocalSession,
		stopLocalSession: (session, config) =>
			stopLocalSession(session, config, async () => {
				if (options.failed) throw new Error("final failed");
				return { text: "final", hadSpeech: true };
			}),
		finalModels: () => [],
		now: () => 0,
		setInterval,
		clearInterval,
		getOrInitVoiceUi: () => ({ ticker: { subscribe: () => () => {} } }),
	};
	const lifecycle = createRecordingLifecycle(deps);
	return {
		lifecycle,
		state,
		controller,
		events,
		writes,
		history,
		notices,
		workers,
		process,
		deps,
		flushes: () => flushes,
		feed(chunk = Buffer.from([1, 0])) {
			process.stdout.emit("data", chunk);
			workers[0]?.emit("message", { type: "ready" });
		},
		partial(text: string, revision = 1) {
			workers[0]?.emit("message", { type: "partial", segmentId: 0, revision, text });
		},
		dispose() {
			if (state.statusTimer) clearInterval(state.statusTimer);
			state.activePreview?.abort();
			abortLocalSession(state.activeSession);
			void client?.destroy();
			retirement.destroyRetiringClients();
			presenter.dispose();
		},
	};
}
