/**
 * pi-voicekit — Enterprise-grade voice STT for Pi CLI.
 *
 * Architecture (modeled after Claude Code's voice pipeline):
 *
 *   STATE MACHINE
 *   ─────────────
 *   idle → warmup → recording → finalizing → idle
 *              ↑         │
 *              └─────────┘  (rapid re-press recovery)
 *
 *   warmup:     User holds SPACE for ≥ HOLD_THRESHOLD_MS (1200ms).
 *               A "keep holding…" hint with countdown is shown. If released before
 *               the threshold, a normal space character is typed (or "hold longer" hint shown).
 *
 *   recording:  SoX captures PCM and buffers it locally.
 *               Release SPACE (or press again in toggle mode) → stop.
 *
 *   finalizing: The buffered audio is decoded by the local model and the finished
 *               transcript is written once. The widget shows the decoding progress.
 *
 *   HOLD-TO-TALK DETECTION
 *   ──────────────────────
 *   Two paths depending on terminal capabilities:
 *
 *   A) Kitty protocol (Ghostty on Linux, Kitty, WezTerm):
 *      True key-down/repeat/release events available.
 *      First SPACE press → enter warmup immediately (show countdown).
 *      Released < 300ms → tap → type a space.
 *      Released 300ms–2s → show "hold longer" hint.
 *      Held ≥ 1.2s → activate recording.
 *      True release event stops recording.
 *
 *   B) Non-Kitty (macOS Terminal, Ghostty on macOS):
 *      No key-release event. Holding sends rapid press events (~30-90ms apart).
 *      First SPACE press → record time, start release-detect timer (500ms).
 *      No more presses within 500ms → TAP → type a space.
 *      Rapid presses detected → user is HOLDING.
 *      After REPEAT_CONFIRM_COUNT (6) rapid presses → enter warmup.
 *      After HOLD_THRESHOLD_MS (1200ms) from first press → activate recording.
 *      Gap > RELEASE_DETECT_MS (500ms) after RECORDING_GRACE_MS (800ms) → stop.
 *
 *   ENTERPRISE FALLBACKS
 *   ────────────────────
 *   • Session corruption guard: new recording request during
 *     finalizing automatically cancels the stale session first.
 *   • Stale transcript cleanup: any prior transcript is cleared
 *     before new recording begins.
 *   • Silence vs. no-speech: distinguishes "mic captured silence"
 *     from "no speech detected" with distinct user messages.
 *
 * Activation:
 *   - Hold SPACE (≥1200ms) → release to finalize
 *   - Configurable shortcut (default Ctrl+Shift+V) → toggle start/stop (always works)

 *
 * Config in Pi's agent directory (settings.json) under "voice": { ... }
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey, Key, type KeyId } from "@earendil-works/pi-tui";

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	DEFAULT_CONFIG,
	DEFAULT_TTS_LOCAL_MODEL,
	getGlobalSettingsPath,
	loadConfigWithSource,
	loadGlobalToggleShortcut,
	saveConfig,
	saveGlobalVoiceFields,
	scrubRetiredVoiceKeys,
	type VoiceConfig,
	type VoiceSettingsScope,
} from "./voice/config";
import { finalizeOnboardingConfig } from "./voice/onboarding";
import { finalPassClient } from "./voice/final-pass-client";
import { makeWidgetRegistry, type WidgetRegistry } from "./voice/ui-widget-base";
import { makeRenderTicker, type RenderTicker } from "./voice/ui-render-ticker";
import { TtsInstallProgressWidget } from "./voice/tts-install-progress";
import { TtsPlaybackIndicator } from "./voice/tts-playback-indicator";
import {
	startLocalSession,
	stopLocalSession,
	abortLocalSession,
	finalModels,
	LOCAL_MODELS,
	SAMPLE_RATE,
	CHANNELS,
	getLanguagesForLocalModel,
	isLanguageSupportedByModel,
	localLanguageDisplayName,
	type LocalSession,
} from "./voice/local";
import { shouldArmReleaseDetectOnRepeat } from "./voice/hold-to-talk";
import { GapTimer, type TimerPort } from "./voice/release-controller";
import { audioToolOrder, type AudioToolName } from "./voice/audio-tool";
import { isPunctuationModelReady, punctuationModelFilePath, punctuationModelPath } from "./voice/punctuation-model";
import {
	preparePunctuation,
	punctuateStage,
	type PunctuationReason,
	type PunctuationStatus,
	type PunctuationGate,
} from "./voice/punctuation";
import { cleanTranscript, type CleanupStatus } from "./voice/transcript-cleanup";
import { createPreviewClient, type PreviewClient } from "./voice/preview-worker-client";
import { type PreviewSession } from "./voice/preview-session";
import { createRecordingOwner, resolvePreviewModelDir } from "./voice/preview-entrypoint";
import type { VoiceState } from "./voice/recording-controller";
import { createRecordingLifecycle } from "./voice/recording-lifecycle";
import { createPreviewRetirement } from "./voice/preview-retirement";
import { createRecordingController } from "./voice/recording-controller";
import { createRecordingPresenter } from "./voice/recording-presenter";

/** Adapter for the real event loop — lets GapTimer run under the real setTimeout. */
const realTimerPort: TimerPort = {
	once(fn, ms) {
		const id = setTimeout(fn, ms);
		return { cancel: () => clearTimeout(id) };
	},
};

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Voice state machine — strict transitions only:
 *   idle → warmup → recording → finalizing → idle
 *   warmup → idle  (released before threshold)
 *   recording → idle  (on error)
 *   finalizing → idle  (on completion or timeout)
 */
// VoiceState is shared with the recording ports; ownership stays in this entrypoint.

// ─── Constants ───────────────────────────────────────────────────────────────

// Hold-to-talk timing — Apple-style deliberate hold detection
// The goal: typing normally should NEVER accidentally trigger voice.
// Only a clearly intentional long press activates it.
// v7.1.3 — hold threshold is configurable via `voice.holdThresholdMs`.
// Default lowered from 1200ms → 700ms for snappier hold-to-talk activation.
// Apple Caps Lock uses ~1s; modern push-to-talk apps tend to use 500-800ms.
// 700ms strikes a balance: too short risks accidental activation while typing
// (a single tap on the spacebar at the end of a word is ~80ms), too long
// feels laggy. Users can dial higher via /voice-hold-delay or settings.json.
const HOLD_THRESHOLD_DEFAULT_MS = 700;
const RELEASE_DETECT_MS = 500; // Gap in key-repeat that means "released" (non-Kitty)
// macOS default InitialKeyRepeat is ~375ms, so 500ms
// ensures the first repeat arrives before we decide "tap"
const REPEAT_CONFIRM_COUNT = 6; // Need this many rapid repeat presses to confirm "holding"
// At ~30ms repeat rate, 6 presses ≈ 180ms of continuous holding
// This filters out brief pauses while typing
const REPEAT_CONFIRM_MS = 700; // Max gap between presses to count as rapid repeat
// macOS initial key-repeat delay is ~417-583ms depending on settings
// Must be > macOS InitialKeyRepeat (~375ms)
const RECORDING_GRACE_MS = 800; // After recording starts, ignore release for this long
// Covers async gap from holdActivationTimer → startVoiceRecording
const RELEASE_DETECT_RECORDING_MS = 250; // During active recording, gap before we consider
// the key released (non-Kitty only). macOS Terminal
// key repeat fires every ~30-50ms. 250ms gap = released.
const TYPING_COOLDOWN_MS = 400; // If ANY non-space key was pressed within this window,
// ignore space holds (user is typing, not activating voice)
const TAIL_RECORDING_MS = 1500; // Keep recording for 1.5s after space release to catch
// trailing words. If user re-presses space within this
// window, cancel the delayed stop and keep recording.
const CORRUPTION_GUARD_MS = 200; // Min gap between stop and restart

// Debug logging — set PI_VOICE_DEBUG=1 to enable
const VOICE_DEBUG = !!process.env.PI_VOICE_DEBUG;
const VOICE_LOG_FILE = path.join(os.tmpdir(), "pi-voice-debug.log");

// ─── Audio level tracking (module scope so streaming can access) ──────
let audioLevel = 0;
let audioLevelSmoothed = 0;

function updateAudioLevel(chunk: Buffer) {
	const len = chunk.length;
	if (len < 2) return;
	const samples = len >> 1;
	let sum = 0;
	// Use Int16Array view when alignment permits (2-byte aligned), else fall back
	if ((chunk.byteOffset & 1) === 0) {
		const view = new Int16Array(chunk.buffer, chunk.byteOffset, samples);
		for (let i = 0; i < view.length; i++) {
			sum += view[i] * view[i];
		}
	} else {
		for (let i = 0; i < len - 1; i += 2) {
			const s = chunk.readInt16LE(i);
			sum += s * s;
		}
	}
	const rms = Math.sqrt(sum / samples);
	// Lower ceiling (2500) so normal speech hits 0.5-0.9 instead of 0.1-0.3
	// Power curve (^0.6) boosts quiet sounds for more visible reactivity
	audioLevel = Math.min(1, Math.pow(Math.min(rms / 2500, 1), 0.6));
	// Faster attack (0.35 old), slower decay — snappy peaks, smooth falloff
	audioLevelSmoothed =
		audioLevel > audioLevelSmoothed
			? audioLevelSmoothed * 0.35 + audioLevel * 0.65
			: audioLevelSmoothed * 0.75 + audioLevel * 0.25;
	// Shared state for other extensions (e.g. pi-pompom mouth animation).
	// Using a namespaced globalThis object instead of pi.events because
	// audio levels update at ~60Hz — event emission would be wasteful.
	const shared = ((globalThis as any).__piListen ??= {});
	shared.audioLevel = audioLevelSmoothed;
}

function voiceDebug(...args: unknown[]) {
	if (!VOICE_DEBUG) return;
	// Diagnostics are best-effort by contract: serialization (a circular value) and the stderr
	// write (EPIPE) can both throw, and the completion path runs its fail-open fallback on this
	// stack — a debug line must never be able to cost a dictation its text.
	try {
		const ts = new Date().toISOString().split("T")[1];
		const line = `[voice ${ts}] ${args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")}\n`;
		try {
			fs.appendFileSync(VOICE_LOG_FILE, line);
		} catch {}
		process.stderr.write(line);
	} catch {}
}

/**
 * Render a thrown value for a log line without ever throwing itself (R18): `String(err)` is
 * not total — a null-prototype object or a hostile `toString` makes it throw — and every caller
 * must not throw: the punctuation step's fail-open fallback runs inside the completion path, and
 * the upgrade notice's catch blocks must not escape session initialisation (R24).
 */
export function safeErrorText(err: unknown): string {
	if (typeof err === "string") return err;
	try {
		return String(err);
	} catch {
		return "<unprintable error>";
	}
}

// Cache command existence checks — avoid sync spawnSync on every recording start
const _cmdExistsCache = new Map<string, boolean>();
function commandExists(cmd: string): boolean {
	const cached = _cmdExistsCache.get(cmd);
	if (cached !== undefined) return cached;
	const which = process.platform === "win32" ? "where" : "which";
	const result = spawnSync(which, [cmd], { stdio: "pipe", timeout: 3000 }).status === 0;
	_cmdExistsCache.set(cmd, result);
	return result;
}

/** Detect the first Windows DirectShow audio input device name via ffmpeg.
 * DirectShow has no "default" alias — must enumerate and pick the first audio device.
 */
function detectWindowsAudioDevice(): string | null {
	try {
		const result = spawnSync("ffmpeg", ["-f", "dshow", "-list_devices", "true", "-i", "dummy"], {
			timeout: 3000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		// ffmpeg outputs device list to stderr
		const output = result.stderr || "";
		// Match lines like: [dshow @ ...] "Microphone (Realtek HD Audio)" (audio)
		const match = output.match(/"([^"]+)"\s*\(audio\)/);
		return match?.[1] || null;
	} catch {
		return null;
	}
}

interface AudioCaptureTool {
	name: string;
	cmd: string;
	args: string[];
}

// Try available audio capture tools in the order given by audioToolOrder()
let _cachedAudioTool: AudioCaptureTool | null | undefined;

function probeSox(): AudioCaptureTool | null {
	if (!commandExists("rec")) return null;
	return {
		name: "sox",
		cmd: "rec",
		args: [
			"-q",
			"--buffer",
			"4096",
			"-c",
			String(CHANNELS),
			"-b",
			"16",
			"-e",
			"signed-integer",
			"-t",
			"raw",
			"-",
			"rate",
			String(SAMPLE_RATE),
		],
	};
}

function probeFfmpeg(): AudioCaptureTool | null {
	if (!commandExists("ffmpeg")) return null;
	const isLinux = process.platform === "linux";
	const isMac = process.platform === "darwin";
	const isWin = process.platform === "win32";
	// Input device varies by platform
	let inputArgs: string[];
	if (isMac) {
		inputArgs = ["-f", "avfoundation", "-i", ":default"];
	} else if (isLinux) {
		inputArgs = ["-f", "pulse", "-i", "default"];
	} else if (isWin) {
		// DirectShow has no "default" alias — enumerate devices and pick the first audio device
		const dshowDevice = detectWindowsAudioDevice();
		inputArgs = dshowDevice ? ["-f", "dshow", "-i", `audio=${dshowDevice}`] : ["-f", "dshow", "-i", "audio=Microphone"]; // last-resort guess
	} else {
		inputArgs = ["-f", "pulse", "-i", "default"]; // fallback for other platforms
	}
	return {
		name: "ffmpeg",
		cmd: "ffmpeg",
		args: [
			...inputArgs,
			"-ac",
			String(CHANNELS),
			"-ar",
			String(SAMPLE_RATE),
			"-sample_fmt",
			"s16",
			"-f",
			"s16le",
			"-loglevel",
			"error",
			"pipe:1",
		],
	};
}

function probeArecord(): AudioCaptureTool | null {
	if (process.platform !== "linux" || !commandExists("arecord")) return null;
	return {
		name: "arecord",
		cmd: "arecord",
		args: ["-q", "-f", "S16_LE", "-r", String(SAMPLE_RATE), "-c", String(CHANNELS), "-t", "raw"],
	};
}

const audioProbes: Record<AudioToolName, () => AudioCaptureTool | null> = {
	sox: probeSox,
	ffmpeg: probeFfmpeg,
	arecord: probeArecord,
};

function detectAudioCaptureTool(): AudioCaptureTool | null {
	if (_cachedAudioTool !== undefined) return _cachedAudioTool;
	for (const name of audioToolOrder()) {
		const tool = audioProbes[name]();
		if (tool) {
			_cachedAudioTool = tool;
			return tool;
		}
	}
	_cachedAudioTool = null;
	return null;
}

// ─── Abort helper — nuke everything synchronously ────────────────────────────

function abortSession(session: LocalSession | null): void {
	if (!session || session.closed) return;
	// Replace callbacks with no-ops BEFORE aborting so any in-flight async work
	// (sherpa transcription, recProcess close) that resolves after abort cannot reach the
	// recording state machine — including across session replacement, where the surviving
	// callbacks would otherwise write into the new session's editor / fire notifications
	// on the new ctx.
	session.onDone = () => {};
	session.onError = () => {};
	abortLocalSession(session);
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let config = DEFAULT_CONFIG;
	let configSource: VoiceSettingsScope | "default" = "default";
	let currentCwd = process.cwd();
	// The controller owns the state value; this closure only reacts to transitions.
	const recordingController = createRecordingController({ debug: voiceDebug });
	let ctx: ExtensionContext | null = null;
	let recordingStart = 0;
	let statusTimer: ReturnType<typeof setInterval> | null = null;
	let terminalInputUnsub: (() => void) | null = null;

	// ─── v7.1 Settings UI: widget registry + render ticker (per session) ──
	// Created lazily on first use (session_start) and torn down in
	// voiceCleanup. Owns all DisposableWidget instances for the session.
	let widgetRegistry: WidgetRegistry | null = null;
	let renderTicker: RenderTicker | null = null;
	function getOrInitVoiceUi(): { registry: WidgetRegistry; ticker: RenderTicker } {
		if (!widgetRegistry) widgetRegistry = makeWidgetRegistry();
		if (!renderTicker) renderTicker = makeRenderTicker();
		return { registry: widgetRegistry, ticker: renderTicker };
	}
	/** Currently-mounted install widgets keyed by modelId — for [esc] routing. */
	const activeInstallWidgets = new Map<string, TtsInstallProgressWidget>();
	/** Currently-mounted playback indicator (one at a time) for [esc] routing. */
	let activePlaybackIndicator: TtsPlaybackIndicator | null = null;

	/**
	 * v7.1.3 — read the active hold-threshold (ms) from config with bounds.
	 * Outside [200, 3000] falls back to the default (700ms). Bounds chosen
	 * so a typo can't make the experience completely broken: 200ms is
	 * effectively single-tap, 3000ms is "RSI-friendly slow press."
	 */
	function getHoldThresholdMs(): number {
		const v = (config as any).holdThresholdMs;
		if (typeof v === "number" && Number.isFinite(v) && v >= 200 && v <= 3000) return v;
		return HOLD_THRESHOLD_DEFAULT_MS;
	}

	// ─── Toggle Shortcut (resolved once at startup, used everywhere) ──────
	const resolvedToggleShortcut = loadGlobalToggleShortcut();
	const toggleShortcutLabel = resolvedToggleShortcut
		.split("+")
		.map((p) => (p.length <= 1 ? p.toUpperCase() : p[0]!.toUpperCase() + p.slice(1)))
		.join("+");

	// Active recording session
	let activeSession: LocalSession | null = null;

	// ─── Offline punctuation (spec §4.3–§4.6) ────────────────────────────────
	// One synchronous, marks-only step between the final transcript and the editor write. The
	// policy is a pure read of the text and the switch; the model is never loaded on this path.
	/**
	/**
	 * The last decision of this session, for `/voice-punctuation status`. In memory only — what
	 * outlives the session is the metadata-only `voice-punctuation` record — and cleared when a
	 * new session starts.
	 */
	let lastPunctuationDecision: { chars: number; status: PunctuationStatus; gate?: PunctuationGate } | null = null;
	/** The first-need notice fires once per runtime, however many dictations follow. */
	let punctuationDownloadNoticeShown = false;
	/** The failure notice fires once per runtime; later needs still retry the download. */
	let punctuationUnavailableNoticeShown = false;
	/** The upgrade notice fires once per runtime even when the flag cannot be persisted. */
	let punctuationUpgradeNoticeShown = false;

	/** A plain-language note per reason code, so `status` explains itself (spec §4.6). */
	const PUNCTUATION_REASON_NOTES: Record<PunctuationReason, string> = {
		"no-model": "the model is not available yet",
		"load-failed": "the model could not be loaded",
		"empty-input": "there was nothing to punctuate",
		"altered-text": "the model's output changed the text, so it was rejected",
		"not-needed": "the applicability rule declined",
		error: "the punctuation step failed",
	};

	/** The gate's own note, so `status` can say which of the three conditions declined (spec §4.6). */
	const PUNCTUATION_GATE_NOTES: Record<PunctuationGate, string> = {
		off: "voice.punctuationEnabled is false",
		"no-cjk": "the transcript has no Chinese characters",
		dense: "its punctuation density is already one mark per 20 characters or more",
		needed: "the step should have run",
	};

	/**
	 * The completion path's punctuation step: clean, decide, apply, record, and never wait.
	 *
	 * The cleanup (spec §4.1–§4.5) runs first and unconditionally on its own switches — a user who
	 * turns marks off still gets clean text — so the model reads the cleaned string (spec §4.6).
	 * `punctuateStage` is the punctuation step proper: it decides (the gate of spec §4.3), splices marks
	 * and reports both, returning the input unchanged on every failure (invariant 2). The pipeline is
	 * therefore *recognise → clean → decide → insert marks → write*, and this is the one place the
	 * middle three happen.
	 * Nothing here loads, downloads or constructs anything — a session builds the engine at start-up,
	 * and a dictation that finds no engine keeps the raw text (invariant 7).
	 *
	 * The whole step — cleanup, decision, splice, diagnostics, notices and the prepare — sits in one
	 * guard, and the fallback itself uses nothing that can throw: a throw must never cost the dictation
	 * its write, its history record or its state reset.
	 */
	function punctuateTranscript(text: string): string {
		// The text the caller writes: the recognised transcript until a step produces a result, so a
		// failure after that point cannot discard a cleanup or a punctuation that already succeeded.
		let output = text;
		let cleanedUp = false;
		let decided = false;
		try {
			// The cleanup (spec §4.1–§4.5) runs first and on its own switches only, so the model reads
			// the text that is about to be written (spec §4.6) — a throw here still returns `text`.
			const charsBefore = Array.from(text).length;
			const cleanupStartedMs = Date.now();
			const cleaned = cleanTranscript(text, {
				fillers: config.fillerRemovalEnabled !== false,
				numerals: config.numeralNormalizationEnabled !== false,
			});
			const elapsedMs = Date.now() - cleanupStartedMs;
			// From here the fallback is the cleaned text: a throw after the cleanup returned must not
			// hand the dictation back with its fillers and spoken numerals still in it.
			output = cleaned.text;
			cleanedUp = true;
			recordCleanupDecision({
				reason: cleaned.status,
				fillersRemoved: cleaned.fillersRemoved,
				numeralsConverted: cleaned.numeralsConverted,
				charsBefore,
				charsAfter: Array.from(cleaned.text).length,
				elapsedMs,
			});

			const result = punctuateStage(cleaned.text, config.punctuationEnabled !== false);
			const gate = result.gate;
			output = result.text;
			const chars = Array.from(cleaned.text).length;
			lastPunctuationDecision = { chars, status: result.status };
			decided = true;

			// One debug line per dictation, applied or not (spec §4.6).
			voiceDebug("punctuation", {
				applied: result.status.applied,
				reason: result.status.reason,
				gate,
				chars,
				marksBefore: result.status.marksBefore,
				marksAfter: result.status.marksAfter,
				elapsedMs: result.status.elapsedMs,
			});

			// One metadata-only record per dictation (spec §4.6) — after the fact this is the only way
			// to answer "why did that one come back without punctuation?"
			recordPunctuationDecision(gate, chars, result.status);

			const unavailable = result.status.reason === "no-model" || result.status.reason === "load-failed";
			if (unavailable) {
				// Retry the background prepare on every qualifying need — it verifies, downloads and
				// constructs off this stack, and does nothing at all once the engine exists. A settle
				// without an engine reports through the hook, which is what the failure notice uses.
				preparePunctuation({ onUnavailable: notifyPunctuationUnavailable, onTransfer: notifyPunctuationDownload });
			}

			return output;
		} catch (err) {
			// Fail-open fallback: `status` must report *this* dictation, never the previous one.
			// Nothing here can throw — the records are guarded, the decision is a plain assignment,
			// and `voiceDebug` swallows its own failures by contract — so this arm completes even
			// when the throw it reports came from a diagnostic; `output` then keeps a cleanup or a
			// punctuation that already succeeded.
			if (!cleanedUp) {
				// The cleanup is what threw, so it is the one step with no result of its own: record
				// the attempt as such. `text` is untouched, so both lengths are the recognised one.
				const chars = Array.from(text).length;
				recordCleanupDecision({
					reason: "error",
					fillersRemoved: 0,
					numeralsConverted: 0,
					charsBefore: chars,
					charsAfter: chars,
					elapsedMs: 0,
				});
			}
			if (!decided) {
				lastPunctuationDecision = {
					chars: Array.from(text).length,
					status: { applied: false, reason: "error", marksBefore: 0, marksAfter: 0, elapsedMs: 0 },
				};
			}
			voiceDebug("completion step threw — continuing with the transcript as it stands", {
				error: safeErrorText(err),
			});
			return output;
		}
	}

	/**
	 * The one-time note about the punctuation model (spec §4.6). Only a real transfer reports it — an
	 * engine that is merely still being built must not — and it is the whole disclosure: the model is
	 * fetched once per machine, and both engines then stay resident for every session.
	 */
	function notifyPunctuationDownload(): void {
		if (punctuationDownloadNoticeShown) return;
		punctuationDownloadNoticeShown = true;
		try {
			ctx?.ui.notify(
				"pi-voicekit is fetching the punctuation model once (285 MB) and then keeps it resident alongside the recogniser — roughly 300 MB of memory each, and dictations are punctuated as soon as the model has been verified",
				"info"
			);
		} catch (err) {
			voiceDebug("punctuation download notice threw", { error: safeErrorText(err) });
		}
	}

	/**
	 * One metadata-only record per dictation (spec §4.6). No transcript text is written, and a
	 * failing record must never cost the dictation anything.
	 */
	function recordPunctuationDecision(gate: PunctuationGate, chars: number, status: PunctuationStatus): void {
		try {
			pi.appendEntry("voice-punctuation", {
				applied: status.applied,
				reason: status.reason,
				gate,
				chars,
				marksBefore: status.marksBefore,
				marksAfter: status.marksAfter,
				elapsedMs: status.elapsedMs,
			});
		} catch (err) {
			voiceDebug("punctuation record failed", { error: safeErrorText(err) });
		}
	}

	/**
	 * One metadata-only record per dictation for the cleanup step (spec §4.5), beside the punctuation
	 * record and with the same guarantees: `reason` is the module's status — `error` when the guard
	 * caught a throw from the cleanup — and both lengths are code points, so they compare with the
	 * punctuation record's `chars`. No transcript text is written, and a failing record must never
	 * cost the dictation anything.
	 */
	function recordCleanupDecision(decision: {
		reason: CleanupStatus | "error";
		fillersRemoved: number;
		numeralsConverted: number;
		charsBefore: number;
		charsAfter: number;
		elapsedMs: number;
	}): void {
		try {
			pi.appendEntry("voice-cleanup", decision);
		} catch (err) {
			voiceDebug("cleanup record failed", { error: safeErrorText(err) });
		}
	}

	/**
	 * The one failure notice (spec §4.6). Called from the prepare's background hook — off the
	 * dictation's stack — and guarded so later failed retries stay silent.
	 */
	function notifyPunctuationUnavailable(): void {
		if (punctuationUnavailableNoticeShown || !ctx?.hasUI) return;
		punctuationUnavailableNoticeShown = true;
		try {
			ctx.ui.notify(
				"Punctuation model could not be downloaded or loaded — transcripts are still cleaned, but get no marks added. /voice-punctuation status",
				"warning"
			);
		} catch (err) {
			voiceDebug("punctuation failure notice threw", { error: safeErrorText(err) });
		}
	}

	/** `/voice-punctuation status` (spec §4.6): read-only switch, model state and last decision. */
	function punctuationStatusReport(): string {
		const enabled = config.punctuationEnabled !== false;
		const lines = [`Voice punctuation: ${enabled ? "on" : "off"}`];
		const modelDir = punctuationModelPath();
		if (isPunctuationModelReady(modelDir)) {
			lines.push("  model: ready — present and digest-verified");
		} else if (fs.existsSync(punctuationModelFilePath("model", modelDir))) {
			// The readiness check above hashed the files, so this branch is a real mismatch or a
			// missing companion file, not a pending verification.
			lines.push("  model: unusable — present but not verified (incomplete or corrupt download)");
		} else {
			lines.push("  model: not downloaded — a qualifying dictation fetches it in the background");
		}

		const last = lastPunctuationDecision;
		if (!last) {
			lines.push("  last:  no dictation in this session yet");
		} else {
			const { applied, reason } = last.status;
			const note =
				reason === "not-needed" && last.gate
					? ` (${PUNCTUATION_GATE_NOTES[last.gate]})`
					: reason
						? ` (${PUNCTUATION_REASON_NOTES[reason]})`
						: "";
			lines.push(
				`  last:  ${applied ? "applied" : `not applied — ${reason}`}${note} — marks ` +
					`${last.status.marksBefore} → ${last.status.marksAfter}, ${last.status.elapsedMs} ms, ${last.chars} chars`
			);
		}

		if (!enabled) lines.push("  switch: voice.punctuationEnabled = false in settings.json");
		return lines.join("\n");
	}

	/**
	 * The one-time post-upgrade notice (spec §4.6): the LLM polish pass is gone, so no dictated
	 * transcript is sent to a model and nothing is charged for one. The flag is global-only and
	 * written field by field, so a read-only settings file costs the persistence but never the
	 * disclosure — the runtime flag still suppresses a repeat until the process ends.
	 */
	function maybeShowPunctuationUpgradeNotice(sessionCtx: ExtensionContext): void {
		if (!sessionCtx.hasUI || punctuationUpgradeNoticeShown || config.punctuationNoticeShown === true) return;
		punctuationUpgradeNoticeShown = true;
		config.punctuationNoticeShown = true;
		try {
			saveGlobalVoiceFields({ punctuationNoticeShown: true });
		} catch (err) {
			voiceDebug("punctuation notice setting write failed", { error: safeErrorText(err) });
		}
		try {
			sessionCtx.ui.notify(
				[
					"Voice polish has been removed — a dictated transcript is no longer sent to an LLM: no API call, no charge.",
					"Chinese transcripts that come back unpunctuated are now punctuated offline instead.",
					"/voice-punctuation status shows whether it ran and why.",
				].join("\n"),
				"info"
			);
		} catch (err) {
			voiceDebug("punctuation upgrade notice threw", { error: safeErrorText(err) });
		}
	}

	let lastStopTime = 0; // For Escape-to-clear-editor within 30s of recording
	let lastEscapeTime = 0; // For double-escape to clear editor
	let recordingStartedAt = 0; // When recording actually started (for grace period)
	let previewClient: PreviewClient | null = null;
	let previewClientModelDir: string | null = null;
	const previewRetirement = createPreviewRetirement({ debug: voiceDebug, safeErrorText, setTimeout, clearTimeout });
	const { retirePreviewClient, finishPreview } = previewRetirement;
	let activePreview: PreviewSession | null = null;
	let recordingOwner: ReturnType<typeof createRecordingOwner> | null = null;

	// Hold-to-talk state
	let kittyReleaseDetected = false;
	let spaceDownTime: number | null = null;
	let holdActivationTimer: ReturnType<typeof setTimeout> | null = null;
	let spaceConsumed = false; // True once threshold passed and recording started
	let releaseGapTimer: GapTimer | null = null; // gap-based release detection (see release-controller.ts)
	let spacePressCount = 0; // Count of rapid space presses (for non-Kitty hold detection)
	let lastSpacePressTime = 0; // Timestamp of last space press event
	let holdConfirmed = false; // True once we've confirmed user is holding (not tapping)
	let errorCooldownUntil = 0; // After an error, block re-activation until this timestamp
	let lastNonSpaceKeyTime = 0; // Timestamp of last non-space keypress (typing cooldown)
	let tailRecordingTimer: ReturnType<typeof setTimeout> | null = null; // Delayed stop after release

	// ─── Recording History ───────────────────────────────────────────────────

	interface RecordingHistoryEntry {
		text: string;
		timestamp: number;
		duration: number;
		mode: "hold" | "toggle" | "dictate";
	}

	const recordingHistory: RecordingHistoryEntry[] = [];
	const MAX_HISTORY = 50;

	function addToHistory(text: string, duration: number, mode: "hold" | "toggle" | "dictate" = "hold") {
		recordingHistory.unshift({ text, timestamp: Date.now(), duration, mode });
		if (recordingHistory.length > MAX_HISTORY) recordingHistory.pop();
	}

	// ─── Continuous Dictation Mode ───────────────────────────────────────────

	let dictationMode = false;

	// ─── Sound Feedback ──────────────────────────────────────────────────────

	// Pre-resolve sound paths once at load time (not per-play)
	const _soundPaths: Record<string, string | null> = {};
	for (const [type, file] of Object.entries({
		start: "/System/Library/Sounds/Tink.aiff",
		stop: "/System/Library/Sounds/Pop.aiff",
		error: "/System/Library/Sounds/Basso.aiff",
	})) {
		_soundPaths[type] = fs.existsSync(file) ? file : null;
	}

	function playSound(type: "start" | "stop" | "error") {
		const file = _soundPaths[type];
		if (!file) return;
		try {
			const proc = spawn("afplay", [file], { stdio: "ignore", detached: true });
			proc.unref();
			proc.on("error", () => {}); // Prevent unhandled error crash
		} catch {}
	}

	// ─── Voice UI ────────────────────────────────────────────────────────────

	function updateVoiceStatus() {
		if (!ctx?.hasUI) return;
		switch (recordingController.state) {
			case "idle": {
				if (!config.enabled) {
					ctx.ui.setStatus("voice", undefined);
					break;
				}
				const modeTag = config.onboarding.completed && config.localModel ? "LOCAL" : "SETUP";
				ctx.ui.setStatus("voice", `MIC ${modeTag}`);
				break;
			}
			case "warmup":
				ctx.ui.setStatus("voice", "MIC HOLD...");
				break;
			case "recording": {
				const secs = Math.round((Date.now() - recordingStart) / 1000);
				// Live audio level meter in status bar
				const meterLen = 4;
				const meterFilled = Math.round(audioLevelSmoothed * meterLen);
				const meter = "█".repeat(meterFilled) + "░".repeat(meterLen - meterFilled);
				ctx.ui.setStatus("voice", `REC ${secs}s ${meter}`);
				break;
			}
			case "finalizing":
				ctx.ui.setStatus("voice", "STT...");
				break;
		}
	}

	function setVoiceState(newState: VoiceState) {
		recordingController.setState(newState);
		const shared = ((globalThis as any).__piListen ??= {});
		shared.recording = newState === "recording";
		updateVoiceStatus();
	}

	// ─── Cleanup helpers ─────────────────────────────────────────────────────

	function clearHoldTimer() {
		if (holdActivationTimer) {
			clearTimeout(holdActivationTimer);
			holdActivationTimer = null;
		}
	}

	function clearReleaseTimer() {
		releaseGapTimer?.cancel();
	}

	function clearWarmupWidget() {
		recordingPresenter.stopWarmupAnimation();
	}

	function clearRecordingAnimTimer() {
		recordingPresenter.stopRecordingAnimation();
	}

	function hideWidget() {
		recordingPresenter.hideIndicator();
	}

	/** Reset all hold-to-talk state to idle. Call after any recording stop/error/cancel. */
	function resetHoldState(opts?: { cooldown?: number }) {
		spaceConsumed = false;
		spaceDownTime = null;
		spacePressCount = 0;
		holdConfirmed = false;
		clearHoldTimer();
		clearReleaseTimer();
		if (opts?.cooldown) errorCooldownUntil = Date.now() + opts.cooldown;
	}

	function voiceCleanup() {
		recordingOwner?.cancel();
		activePreview?.abort();
		activePreview = null;
		recordingController.begin();
		void previewClient?.destroy().catch((error) => {
			voiceDebug("preview destroy failed", { error: safeErrorText(error) });
		});
		previewClient = null;
		previewClientModelDir = null;
		previewRetirement.finish = null;
		previewRetirement.destroyRetiringClients();
		// v7.1: cancel in-flight installs FIRST so their AbortControllers
		// fire before we drop UI state. Without this, a session_shutdown
		// during a download would leave the network/disk work running
		// after the widget slot is cleared (Codex v6 finding #3).
		for (const w of Array.from(activeInstallWidgets.values())) {
			try {
				w.cancel();
			} catch (err) {
				voiceDebug("install widget cancel threw during voiceCleanup", String(err));
			}
		}
		activeInstallWidgets.clear();
		// Stop any active playback the same way.
		try {
			activePlaybackIndicator?.stop();
		} catch (err) {
			voiceDebug("playback stop threw during voiceCleanup", String(err));
		}
		activePlaybackIndicator = null;
		// Drain registry — each widget self-clears its slot via dispose().
		try {
			widgetRegistry?.disposeAll();
		} catch (err) {
			voiceDebug("widgetRegistry.disposeAll threw", String(err));
		}
		try {
			renderTicker?.dispose();
		} catch (err) {
			voiceDebug("renderTicker.dispose threw", String(err));
		}
		widgetRegistry = null;
		renderTicker = null;

		if (statusTimer) {
			clearInterval(statusTimer);
			statusTimer = null;
		}
		cancelDelayedStop();
		clearWarmupWidget();
		clearRecordingAnimTimer();
		// Reset audio levels
		audioLevel = 0;
		audioLevelSmoothed = 0;
		if (activeSession) {
			abortSession(activeSession);
			activeSession = null;
		}

		resetHoldState(); // includes clearHoldTimer + clearReleaseTimer
		_startingRecording = false;
		lastSpacePressTime = 0;
		lastNonSpaceKeyTime = 0;
		errorCooldownUntil = 0;
		dictationMode = false;
		recordingStart = 0;
		recordingStartedAt = 0;
		lastStopTime = 0;
		if (terminalInputUnsub) {
			terminalInputUnsub();
			terminalInputUnsub = null;
		}
		hideWidget();
		setVoiceState("idle");
	}

	/**
	 * Disarm dictation only: a warm-up or recording in progress is cancelled and the hold state is
	 * reset, while everything unrelated keeps running — in-flight installs, speech playback and other
	 * widgets. `voiceCleanup` is the full teardown (session end, disabled voice); nothing that just lost
	 * its model may use it, because cancelling a download or a speech the user started for another
	 * reason is not "dictation is no longer armed".
	 */
	function disarmDictation() {
		recordingOwner?.cancel();
		activePreview?.abort();
		recordingController.begin();
		if (activeSession) {
			abortSession(activeSession);
			activeSession = null;
		}
		cancelDelayedStop();
		clearWarmupWidget();
		clearRecordingAnimTimer();
		hideWidget();
		resetHoldState();
		_startingRecording = false;
		// The flag dies with the mode it describes: a panel round-trip that clears the model mid-dictation
		// disarms here, and leaving it set would make the next toggle press a "Dictation mode stopped."
		// no-op instead of a start. `voiceCleanup` resets it for the same reason.
		dictationMode = false;
		audioLevel = 0;
		audioLevelSmoothed = 0;
		recordingStart = 0;
		recordingStartedAt = 0;
		setVoiceState("idle");
	}

	async function finalizeAndSaveSetup(
		uiCtx: ExtensionContext | ExtensionCommandContext,
		nextConfig: VoiceConfig,
		selectedScope: VoiceSettingsScope,
		summaryLines: string[],
		source: "first-run" | "setup-command"
	) {
		// One capture path, so a saved setup is always usable: there is no key to check.
		if (config.localModel !== nextConfig.localModel || config.language !== nextConfig.language) {
			await finalPassClient.destroy();
		}
		config = finalizeOnboardingConfig(nextConfig, { validated: true, source });
		configSource = selectedScope;
		const savedPath = saveConfig(config, selectedScope, currentCwd, { loadedSource: configSource });
		uiCtx.ui.notify(["Voice setup complete.", ...summaryLines, "", `Saved to ${savedPath}`].join("\n"), "info");
	}

	// ─── Warmup Widget ──────────────────────────────────────────────────────
	// ─── Minimal Voice Indicators ──────────────────────────────────────

	function getRecordDot(): string {
		// v7.2 — soft pulse between full and dim. Two-state instead of
		// three-state (cleaner, more like a breathing LED indicator
		// than the v7.0 multi-glyph approach).
		const phase = (Math.sin(Date.now() / 700) + 1) / 2;
		return phase > 0.5 ? "●" : "○";
	}

	function buildMiniWave(level: number): string {
		// Legacy block-bar wave — retained for compatibility with any
		// caller that still uses it. New code should use buildAuroraWave.
		const bars = "▁▂▃▄▅▆▇█";
		const len = 12;
		let out = "";
		const t = Date.now() / 1000;
		const energy = Math.pow(level, 0.7);
		for (let i = 0; i < len; i++) {
			const pos = i / len;
			const wave1 = Math.sin(t * 4.5 + i * 0.9) * 0.35;
			const wave2 = Math.sin(t * 7.2 + i * 1.4 + 2.0) * 0.15;
			const center = 1.0 - Math.abs(pos - 0.5) * 1.2;
			const base = 0.15 + energy * 0.85;
			const value = Math.max(0, Math.min(1, (wave1 + wave2 + 0.5) * base * center));
			const idx = Math.min(bars.length - 1, Math.round(value * (bars.length - 1)));
			out += bars[idx];
		}
		return out;
	}

	/**
	 * v7.2 world-class — Liquid Braille audio waveform with truecolor
	 * Aurora gradient. Per Gemini design recommendation:
	 *   - 8 effective vertical levels per CELL (4 dots × 2 columns) via
	 *     braille — vs 8 levels per cell with block-bars.
	 *   - 2 audio samples per cell width — 2× density of block-bar wave.
	 *   - Per-cell color picks an aurora stop based on local peak;
	 *     loud peaks "burn" into hot peach/red, soft tails stay cool
	 *     lavender. RGB interpolated at runtime.
	 * Output is `cells` cells wide rendered as a single string with
	 * inline ANSI 24-bit escapes; ends with a reset. Caller-side
	 * width math should use `cells` not the byte-length of the result.
	 */
	function buildAuroraWave(level: number, cells = 16): string {
		// Generate 2*cells audio "samples" via multi-frequency sine
		// + the live RMS energy. Same organic motion as the legacy
		// wave but at higher density.
		const samples = 2 * cells;
		const t = Date.now() / 1000;
		const energy = Math.pow(level, 0.7);
		const arr: number[] = [];
		for (let i = 0; i < samples; i++) {
			const pos = i / samples;
			const wave1 = Math.sin(t * 4.5 + i * 0.45) * 0.35;
			const wave2 = Math.sin(t * 7.2 + i * 0.7 + 2.0) * 0.15;
			const center = 1.0 - Math.abs(pos - 0.5) * 1.0;
			const base = 0.1 + energy * 0.9;
			const value = Math.max(0, Math.min(1, (wave1 + wave2 + 0.5) * base * center));
			arr.push(value);
		}
		// Lazy-import to keep voice.ts hot path fast on cold start.
		const { liquidBraille, auroraColor } = require("./voice/ui-aura") as typeof import("./voice/ui-aura");
		return liquidBraille(arr, auroraColor);
	}

	// ─── Warmup Widget ──────────────────────────────────────────────────
	// Presentation is injected; lifecycle, generation and preview ownership stay here.
	const recordingPresenter = createRecordingPresenter({
		registry: () => getOrInitVoiceUi().registry,
		hasUI: () => !!ctx?.hasUI,
		now: () => Date.now(),
		getHoldThresholdMs,
		getRecordingStart: () => recordingStart,
		getAudioLevel: () => audioLevelSmoothed,
		setWidget: (key, widget, opts) => ctx?.ui.setWidget(key, widget, opts),
		schedule(frame, ms) {
			const timer = setInterval(frame, ms);
			return () => clearInterval(timer);
		},
		setState: setVoiceState,
		notify: (message, level) => ctx?.ui.notify(message, level),
		playSound,
		debug: voiceDebug,
	});

	function showWarmupWidget() {
		recordingPresenter.mountWarmupIndicator();
	}

	function showRecordingWidget() {
		recordingPresenter.mountRecordingIndicator();
	}

	function showRecordingWidgetFrame() {
		recordingPresenter.renderRecordingFrame();
	}

	// ─── Voice: Start / Stop ─────────────────────────────────────────────────

	let _startingRecording = false; // Re-entrancy guard for startVoiceRecording

	async function startVoiceRecording(): Promise<boolean> {
		voiceDebug("startVoiceRecording called", {
			voiceState: recordingController.state,
			hasUI: !!ctx?.hasUI,
			starting: _startingRecording,
		});
		// A recording needs an explicit local model: `local.ts` substitutes DEFAULT_LOCAL_MODEL when
		// `config.localModel` is unset, so any entry that starts without one downloads and runs a model
		// the user never chose. Enforced HERE, at the shared entry, and not per entry point — the SPACE
		// hold, the toggle shortcut, dictation mode and the settings panel all arrive through this
		// function, so a new entry point cannot miss the requirement. `setupHoldToTalk` refuses to arm
		// for the same reason; that is the arming side of the same rule, not a second copy of it.
		if (!config.localModel) {
			voiceDebug("startVoiceRecording refused: no local model configured");
			try {
				ctx?.ui.notify(
					"pi-voicekit needs a local model before it can dictate. Run /voice-setup to choose one.",
					"warning"
				);
			} catch (err) {
				voiceDebug("no-model notice threw", { error: String(err) });
			}
			return false;
		}
		if (!ctx?.hasUI) return false;
		if (_startingRecording) return false; // Prevent overlapping starts during corruption guard sleep
		_startingRecording = true;

		abortActiveSpeak();
		let staleStart = false;

		try {
			// ── SESSION CORRUPTION GUARD ──
			// If we're still finalizing from a previous recording, abort it first.
			// This prevents the "slow connection overlaps new recording" bug.
			if (recordingController.state === "finalizing" || recordingController.state === "recording") {
				recordingOwner?.cancel();
				activePreview?.abort();
				const generation = recordingController.begin();
				abortSession(activeSession);
				activeSession = null;
				clearRecordingAnimTimer();
				clearWarmupWidget();
				hideWidget();
				setVoiceState("idle");
				// Brief pause to let resources release
				await new Promise((r) => setTimeout(r, CORRUPTION_GUARD_MS));
				if (!recordingController.owns(generation)) {
					staleStart = true;
					return false;
				}
			}

			// ── STALE TRANSCRIPT CLEANUP ──
			// Don't hideWidget() here — the warmup widget is still showing and
			// showRecordingWidget() will seamlessly replace it using the same
			// widget ID. Hiding it first causes a visible gap (jitter).

			recordingStart = Date.now();

			return startRecording();
		} finally {
			if (!staleStart) _startingRecording = false;
		}
	}

	const { startRecording, stopVoiceRecording } = createRecordingLifecycle({
		state: {
			get config() {
				return config;
			},
			get ctx() {
				return ctx;
			},
			get activeSession() {
				return activeSession;
			},
			set activeSession(value) {
				activeSession = value;
			},
			get activePreview() {
				return activePreview;
			},
			set activePreview(value) {
				activePreview = value;
			},
			get recordingOwner() {
				return recordingOwner;
			},
			set recordingOwner(value) {
				recordingOwner = value;
			},
			get statusTimer() {
				return statusTimer;
			},
			set statusTimer(value) {
				statusTimer = value;
			},
			get lastStopTime() {
				return lastStopTime;
			},
			set lastStopTime(value) {
				lastStopTime = value;
			},
			get recordingStart() {
				return recordingStart;
			},
			get kittyReleaseDetected() {
				return kittyReleaseDetected;
			},
			get spaceDownTime() {
				return spaceDownTime;
			},
		},
		entry: {
			recordingController,
			debug: voiceDebug,
			setState: setVoiceState,
			getConfig: () => config,
			getContext: () => ctx,
			abortPreview: () => activePreview?.abort(),
			setOwner: (value) => {
				recordingOwner = value;
			},
			resolvePreviewModelDir,
			createPreviewClient,
			createRecordingOwner,
			retirePreviewClient,
			preview: {
				get client() {
					return previewClient;
				},
				set client(value) {
					previewClient = value;
				},
				get modelDir() {
					return previewClientModelDir;
				},
				set modelDir(value) {
					previewClientModelDir = value;
				},
				get finish() {
					return previewRetirement.finish;
				},
				set finish(value) {
					previewRetirement.finish = value;
				},
			},
		},
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
		setInterval,
		clearInterval,
		getOrInitVoiceUi,
		now: Date.now,
	});

	// ── Tail recording: keep capturing for 1.5s after space release ──
	function scheduleDelayedStop() {
		cancelDelayedStop(); // Clear any existing timer
		voiceDebug("scheduleDelayedStop → will stop in", TAIL_RECORDING_MS, "ms");
		tailRecordingTimer = setTimeout(() => {
			tailRecordingTimer = null;
			voiceDebug("tailRecordingTimer fired → stopping recording");
			stopVoiceRecording();
		}, TAIL_RECORDING_MS);
	}

	function cancelDelayedStop() {
		if (tailRecordingTimer) {
			clearTimeout(tailRecordingTimer);
			tailRecordingTimer = null;
			voiceDebug("cancelDelayedStop → tail recording timer cleared");
		}
	}

	// ─── Hold-to-Talk State Machine ─────────────────────────────────────────
	//
	// SPACE key handling with STRICT hold-duration detection.
	//
	// TWO TERMINAL MODES:
	//
	// A) KITTY PROTOCOL (Ghostty on Linux, Kitty, WezTerm, etc.):
	//    True key-down/repeat/release events. On first SPACE press,
	//    immediately enter warmup (show countdown). If released before
	//    HOLD_THRESHOLD_MS → cancel warmup, type a space. If held past
	//    threshold → start recording. True release event stops recording.
	//    No timer-based release detection needed.
	//
	// B) NON-KITTY (macOS Terminal, Ghostty on macOS, etc.):
	//    No key-release event. Holding sends rapid press events (~30-90ms apart).
	//    A single tap sends exactly ONE press.
	//    Algorithm:
	//      1. First SPACE press → record time, start release-detect timer.
	//      2. No more presses within RELEASE_DETECT_MS (500ms) → TAP → type space.
	//      3. Rapid presses arrive → user is HOLDING. After REPEAT_CONFIRM_COUNT
	//         rapid presses → enter warmup, show countdown.
	//      4. After HOLD_THRESHOLD_MS (1200ms) from first press → start recording.
	//      5. Recording continues while key-repeat events arrive.
	//         Gap > RELEASE_DETECT_MS after RECORDING_GRACE_MS → stop.
	//
	// The RECORDING_GRACE_MS prevents the state transition at recording start
	// from being mistaken for a key release (brief gap in events).

	function onSpaceReleaseDetected() {
		// GapTimer has already self-cleared (single-shot); nothing to reset here.
		voiceDebug("onSpaceReleaseDetected", {
			voiceState: recordingController.state,
			holdConfirmed,
			spaceConsumed,
			spaceDownTime,
			spacePressCount,
			timeSinceRecStart: spaceConsumed ? Date.now() - recordingStartedAt : null,
		});

		// If we never confirmed this was a hold (< REPEAT_CONFIRM_COUNT rapid presses),
		// then it was a TAP → space already passed through naturally (not consumed)
		if (!holdConfirmed && recordingController.state === "idle") {
			resetHoldState();
			clearWarmupWidget();
			hideWidget();
			// No need to type a space — the first press was NOT consumed,
			// so it already reached the focused UI component naturally.
			return;
		}

		// Released during warmup — cancel (user held but not long enough)
		if (recordingController.state === "warmup") {
			resetHoldState();
			clearWarmupWidget();
			hideWidget();
			setVoiceState("idle");
			spaceDownTime = null;
			spaceConsumed = false;
			spacePressCount = 0;
			holdConfirmed = false;
			// Don't type a space — user clearly intended to trigger voice but let go too early
			ctx?.ui.notify("Hold SPACE longer to activate voice.", "info");
			return;
		}

		// Released during recording — but ONLY if grace period has passed.
		// The grace period prevents the recording-start transition from being
		// mistaken for a key release.
		if (spaceConsumed && recordingController.state === "recording") {
			const timeSinceRecordingStart = Date.now() - recordingStartedAt;
			voiceDebug("release detected during recording", { timeSinceRecordingStart, RECORDING_GRACE_MS });
			if (timeSinceRecordingStart < RECORDING_GRACE_MS) {
				// Too soon after recording started — this is likely a false release
				// caused by the state transition. Re-arm the release detector.
				voiceDebug("  → too soon, re-arming (grace period)");
				resetReleaseDetect();
				return;
			}
			voiceDebug("  → scheduling delayed stop (tail recording)");
			resetHoldState();
			scheduleDelayedStop();
		}
	}

	function resetReleaseDetect() {
		clearReleaseTimer();
		if (
			recordingController.state === "warmup" ||
			recordingController.state === "recording" ||
			spaceDownTime ||
			spaceConsumed ||
			holdConfirmed
		) {
			// Use longer timeout during active recording — key repeats can be
			// irregular when the system is under load (audio capture, etc.)
			const timeout =
				recordingController.state === "recording" || spaceConsumed ? RELEASE_DETECT_RECORDING_MS : RELEASE_DETECT_MS;
			voiceDebug("resetReleaseDetect", { timeout, voiceState: recordingController.state, spaceConsumed });
			releaseGapTimer = new GapTimer(realTimerPort, { ms: timeout, onFire: onSpaceReleaseDetected });
			releaseGapTimer.arm();
		}
	}

	function setupHoldToTalk() {
		if (!ctx?.hasUI) return;
		// Registered in EVERY configuration — this handler is not only dictation. F1 opens help and
		// Escape cancels an in-flight install or stops speech playback, and both must work for a user who
		// has not chosen a model yet. Only the SPACE branch is model-gated (see "SPACE handling" below),
		// and `startVoiceRecording` keeps the recording-side guard for the same rule.

		if (terminalInputUnsub) {
			terminalInputUnsub();
			terminalInputUnsub = null;
		}

		terminalInputUnsub = ctx.ui.onTerminalInput((data: string) => {
			if (!config.enabled) return undefined;

			// v7.1 §4 — escape priority routing for v7.1 widgets. When
			// no overlay (panel/help/picker) is in front (those run
			// inside ctx.ui.custom() and consume their own input), the
			// fallthrough order is: install widget → playback indicator
			// → editor. Most recent install wins precedence.
			if (matchesKey(data, Key.escape)) {
				if (activeInstallWidgets.size > 0) {
					// Most recent install — Maps preserve insertion order.
					const ids = Array.from(activeInstallWidgets.keys());
					const lastId = ids[ids.length - 1]!;
					const w = activeInstallWidgets.get(lastId);
					if (w) {
						w.cancel();
						return { consume: true };
					}
				}
				if (activePlaybackIndicator) {
					activePlaybackIndicator.stop();
					return { consume: true };
				}
			}

			// v7.1 §11 — F1 always opens help, regardless of context.
			// `?` is intentionally NOT bound here because the user is
			// in the editor and ? is a literal character. Help is
			// reachable by F1 or /voice-help instead.
			if (matchesKey(data, Key.f1) && ctx?.hasUI) {
				openHelpOverlay(ctx as unknown as ExtensionCommandContext).catch(() => {});
				return { consume: true };
			}

			// ── Track non-space keypresses for typing cooldown ──
			// If user was just typing (non-space key within TYPING_COOLDOWN_MS),
			// don't let space holds activate voice — they're just typing.
			if (!matchesKey(data, "space") && !isKeyRelease(data) && !isKeyRepeat(data)) {
				// Regular keypress that isn't space — user is typing
				if (data.length > 0 && data.charCodeAt(0) >= 32) {
					lastNonSpaceKeyTime = Date.now();
				}
			}

			// ── SPACE handling ──
			if (matchesKey(data, "space")) {
				// Dictation needs an explicit local model: `local.ts` substitutes DEFAULT_LOCAL_MODEL when
				// one is missing, so a hold here would download and run a model the user was just told to
				// choose. The event is NOT consumed — the space stays an ordinary character — and the
				// auxiliary keys above are unaffected because they are handled before this branch.
				if (!config.localModel) return undefined;
				// ── ERROR COOLDOWN: block all voice activation for 5s after an error ──
				if (errorCooldownUntil > Date.now()) {
					// During cooldown, let space through as a normal character
					return undefined;
				}

				// ── TYPING COOLDOWN: if user was just typing, let space through ──
				// Apple-style: if a non-space key was pressed recently, this space
				// is part of typing (e.g., "hello world"), not a voice activation.
				// Only applies to NEW activations — don't interrupt active recording.
				if (
					recordingController.state === "idle" &&
					!spaceConsumed &&
					lastNonSpaceKeyTime > 0 &&
					Date.now() - lastNonSpaceKeyTime < TYPING_COOLDOWN_MS
				) {
					return undefined;
				}

				voiceDebug("SPACE event", {
					isRelease: isKeyRelease(data),
					isRepeat: isKeyRepeat(data),
					voiceState: recordingController.state,
					kittyReleaseDetected,
					holdConfirmed,
					spaceConsumed,
					spacePressCount,
					spaceDownTime: spaceDownTime ? Date.now() - spaceDownTime : null,
					dataHex: Buffer.from(data).toString("hex"),
				});

				// ── Kitty key-release (true release event) ──
				if (isKeyRelease(data)) {
					kittyReleaseDetected = true;
					clearReleaseTimer();

					// Released during warmup → cancel
					// If released very quickly (< 300ms), it was a tap → type a space
					// If released after 300ms+, user was trying voice → show hint
					if (recordingController.state === "warmup") {
						const holdDuration = spaceDownTime ? Date.now() - spaceDownTime : 0;
						resetHoldState();
						clearWarmupWidget();
						hideWidget();
						setVoiceState("idle");
						if (holdDuration < 300) {
							// Quick tap — just type a space
							if (ctx?.hasUI) ctx.ui.setEditorText((ctx.ui.getEditorText() || "") + " ");
						} else {
							// Held long enough to see warmup but let go → show hint
							ctx?.ui.notify("Hold SPACE longer to activate voice.", "info");
						}
						return { consume: true };
					}

					// Tap: released before warmup even started (shouldn't happen in
					// Kitty path since we enter warmup on first press, but handle anyway)
					if (spaceDownTime && !holdConfirmed && recordingController.state === "idle") {
						resetHoldState();
						if (ctx?.hasUI) ctx.ui.setEditorText((ctx.ui.getEditorText() || "") + " ");
						return { consume: true };
					}

					// Released during recording → schedule delayed stop (tail recording)
					if (spaceConsumed && recordingController.state === "recording") {
						resetHoldState();
						scheduleDelayedStop();
						return { consume: true };
					}

					spaceDownTime = null;
					spaceConsumed = false;
					spacePressCount = 0;
					holdConfirmed = false;
					return undefined;
				}

				// ── Kitty key-repeat ──
				if (isKeyRepeat(data)) {
					// #13: terminals without key-release events (e.g. Ghostty on
					// macOS, non-kitty modes) signal "released" purely by a GAP in
					// repeat events. Every repeat must re-arm the release-detect
					// timer — recording start clears it, and if nothing re-arms it
					// the release is never detected → hold-to-talk locks up forever.
					if (shouldArmReleaseDetectOnRepeat({ voiceState: recordingController.state, kittyReleaseDetected })) {
						resetReleaseDetect();
					}
					// Already in recording/finalizing — consume (release timer kept alive above)
					if (
						recordingController.state === "recording" ||
						recordingController.state === "finalizing" ||
						spaceConsumed
					) {
						return { consume: true };
					}
					// Already in warmup — consume (hold timer is running)
					if (recordingController.state === "warmup") {
						return { consume: true };
					}

					// During initial hold detection: if we took PATH B on first
					// press (because kittyReleaseDetected was false), we need to
					// count these repeats to confirm the hold. Update state so
					// onSpaceReleaseDetected won't fire a false tap.
					if (spaceDownTime && !holdConfirmed) {
						// NOTE: Do NOT set kittyReleaseDetected here!
						// Ghostty on macOS sends repeat events but NO release events.
						// Only a true isKeyRelease() should flip the Kitty flag.

						const now = Date.now();
						spacePressCount++;
						lastSpacePressTime = now;

						// Enough repeats to confirm hold — enter warmup
						if (spacePressCount >= REPEAT_CONFIRM_COUNT) {
							holdConfirmed = true;
							setVoiceState("warmup");
							showWarmupWidget();

							const alreadyElapsed = now - (spaceDownTime || now);
							const remaining = Math.max(0, getHoldThresholdMs() - alreadyElapsed);

							holdActivationTimer = setTimeout(() => {
								holdActivationTimer = null;
								if (recordingController.state === "warmup") {
									// Don't clearWarmupWidget() here — showRecordingWidget()
									// seamlessly replaces it using the same widget ID.
									spaceConsumed = true;
									recordingStartedAt = Date.now();
									// Clear release timer during async recording startup to
									// prevent a false stop. The 250ms gap timer is re-armed
									// once recording is actually ready — see startRecording (#13).
									clearReleaseTimer();
									voiceDebug("holdActivationTimer fired → starting recording (Kitty repeat path)");
									startVoiceRecording()
										.then((ok) => {
											if (!ok) {
												resetHoldState();
												setVoiceState("idle");
											}
										})
										.catch((err) => {
											voiceDebug("startVoiceRecording THREW", { error: String(err) });
											resetHoldState({ cooldown: 5000 });
											setVoiceState("idle");
										});
								} else {
									spaceDownTime = null;
									spaceConsumed = false;
									spacePressCount = 0;
									holdConfirmed = false;
								}
							}, remaining);
						}

						// Re-arm gap-based release detection — this is how
						// Ghostty-on-macOS (repeats but no release) detects
						// the key being released. (Preserved from the original
						// ordering — the recording-path re-arm above is separate.)
						resetReleaseDetect();
						return { consume: true };
					}

					return { consume: true };
				}

				// === Key PRESS (not repeat, not release) ===
				//
				// TWO TERMINAL MODES:
				//
				// A) Kitty protocol (kittyReleaseDetected = true):
				//    Press fires ONCE on key-down. Repeats come as isKeyRepeat().
				//    Release comes as isKeyRelease(). NO timer-based release detection
				//    needed — the true release event handles everything.
				//    On first press: enter warmup immediately and start hold timer.
				//    (No need to wait for repeats to confirm hold.)
				//
				// B) Non-Kitty (macOS Terminal, etc.):
				//    Holding a key sends rapid "press" events (~30-90ms apart).
				//    A single tap sends exactly ONE press. There is NO release event.
				//    We detect "tap vs hold" by counting rapid presses, and detect
				//    "release" when no press arrives within RELEASE_DETECT_MS.

				// If finalizing → ignore
				if (recordingController.state === "finalizing") {
					return { consume: true };
				}

				// If already recording → cancel any pending delayed stop and keep going
				if (recordingController.state === "recording") {
					cancelDelayedStop(); // User re-pressed — they want to keep recording
					spaceConsumed = true; // Re-arm hold state for the continued recording
					spaceDownTime = Date.now();
					holdConfirmed = true;
					if (!kittyReleaseDetected) {
						voiceDebug("SPACE during recording → cancel delayed stop, re-arm release detect");
						resetReleaseDetect();
					} else {
						voiceDebug("SPACE during recording → cancel delayed stop (Kitty)");
					}
					return { consume: true };
				}

				// If already in warmup → consume
				if (recordingController.state === "warmup") {
					if (!kittyReleaseDetected) {
						voiceDebug("SPACE during warmup → re-arm release detect");
						resetReleaseDetect();
					}
					return { consume: true };
				}

				// If we've already consumed space for this hold → consume
				// This handles the gap between holdActivationTimer firing and
				// recordingController.state transitioning to "recording" (async gap)
				if (spaceConsumed) {
					if (!kittyReleaseDetected) {
						voiceDebug("SPACE while spaceConsumed (async gap) → re-arm release detect");
						resetReleaseDetect();
					}
					return { consume: true };
				}

				// ──────────────────────────────────────────────────────────
				// PATH A: Kitty protocol — true key events available
				// ──────────────────────────────────────────────────────────
				if (kittyReleaseDetected) {
					// First press → immediately enter warmup (release event
					// will cancel if it was a tap)
					if (recordingController.state === "idle") {
						spaceDownTime = Date.now();
						spaceConsumed = false;
						spacePressCount = 1;
						lastSpacePressTime = Date.now();
						holdConfirmed = true; // Kitty: trust the press, release cancels

						setVoiceState("warmup");
						showWarmupWidget();

						holdActivationTimer = setTimeout(() => {
							holdActivationTimer = null;
							if (recordingController.state === "warmup") {
								// Don't clearWarmupWidget() here — showRecordingWidget()
								// seamlessly replaces it using the same widget ID.
								spaceConsumed = true;
								recordingStartedAt = Date.now();
								voiceDebug("holdActivationTimer fired → starting recording (Kitty path)");
								startVoiceRecording()
									.then((ok) => {
										if (!ok) {
											resetHoldState();
											setVoiceState("idle");
										}
									})
									.catch((err) => {
										voiceDebug("startVoiceRecording THREW", { error: String(err) });
										resetHoldState({ cooldown: 5000 });
										setVoiceState("idle");
									});
							} else {
								spaceDownTime = null;
								spaceConsumed = false;
								spacePressCount = 0;
								holdConfirmed = false;
							}
						}, getHoldThresholdMs());

						return { consume: true };
					}
					return { consume: true };
				}

				// ──────────────────────────────────────────────────────────
				// PATH B: Non-Kitty — gap-based hold/release detection
				// ──────────────────────────────────────────────────────────
				// Holding a key sends rapid press events.
				// We count presses and measure gaps to detect holds vs taps.
				if (spaceDownTime) {
					const now = Date.now();
					const gap = now - lastSpacePressTime;

					if (gap < REPEAT_CONFIRM_MS) {
						// Rapid press = user is holding
						spacePressCount++;
						lastSpacePressTime = now;

						if (spacePressCount >= REPEAT_CONFIRM_COUNT && !holdConfirmed) {
							holdConfirmed = true;
							setVoiceState("warmup");
							showWarmupWidget();

							const alreadyElapsed = now - spaceDownTime;
							const remaining = Math.max(0, getHoldThresholdMs() - alreadyElapsed);

							holdActivationTimer = setTimeout(() => {
								holdActivationTimer = null;
								if (recordingController.state === "warmup") {
									// Don't clearWarmupWidget() here — showRecordingWidget()
									// seamlessly replaces it using the same widget ID.
									spaceConsumed = true;
									recordingStartedAt = Date.now();
									// CRITICAL: Clear release timer and DO NOT re-arm.
									// The next key-repeat press event will re-arm it.
									// Without this, the async startVoiceRecording creates
									// a gap where the release timer fires falsely.
									clearReleaseTimer();
									voiceDebug("holdActivationTimer fired → starting recording (non-Kitty)");
									startVoiceRecording()
										.then((ok) => {
											if (!ok) {
												resetHoldState();
												setVoiceState("idle");
											}
											// Do NOT re-arm release detect here!
											// The next SPACE key-repeat event will do it.
											// Re-arming here causes false stops because
											// the timer fires during the async gap.
										})
										.catch((err) => {
											voiceDebug("startVoiceRecording THREW", { error: String(err) });
											resetHoldState({ cooldown: 5000 });
											setVoiceState("idle");
										});
								} else {
									spaceDownTime = null;
									spaceConsumed = false;
									spacePressCount = 0;
									holdConfirmed = false;
								}
							}, remaining);
						}

						resetReleaseDetect();
						return { consume: true };
					} else {
						// Gap too large → previous hold abandoned, new tap
						const wasInWarmup = (recordingController.state as VoiceState) === "warmup";
						resetHoldState();
						clearWarmupWidget();
						hideWidget();
						if (wasInWarmup) setVoiceState("idle");
						// Only type a space if we weren't already in warmup
						// (if we were in warmup, user was trying to activate voice, not type)
						// Note: first space already passed through naturally (not consumed)
						// so we don't need to manually type it here
						// Fall through to treat this as a new first press
					}
				}

				// IDLE — first SPACE press (non-Kitty path)
				// Do NOT consume — let it pass through to whatever UI is focused
				// (editor, search box, picker, etc.). Only start consuming after
				// we confirm it's a hold via REPEAT_CONFIRM_COUNT rapid presses.
				if (recordingController.state === "idle") {
					spaceDownTime = Date.now();
					spaceConsumed = false;
					spacePressCount = 1;
					lastSpacePressTime = Date.now();
					holdConfirmed = false;

					resetReleaseDetect();

					// Don't consume — let the space reach the focused UI component
					return undefined;
				}

				if (spaceConsumed) return { consume: true };
				return undefined;
			}

			// ── Any other key pressed → cancel potential hold ──
			if (spaceDownTime && !holdConfirmed && recordingController.state === "idle") {
				resetHoldState();
				// No need to insert a space manually — the first space press was
				// already allowed to pass through to the focused UI component.
				return undefined;
			}

			if (recordingController.state === "warmup" && holdConfirmed && !spaceConsumed) {
				clearWarmupWidget();
				hideWidget();
				resetHoldState();
				setVoiceState("idle");
				return undefined;
			}

			// ── Escape key — cancel voice / double-escape clears editor ──
			// Skip release/repeat events — only act on actual presses
			if (matchesKey(data, "escape") && !isKeyRelease(data) && !isKeyRepeat(data)) {
				// During recording: cancel recording and clear transcript
				if (
					recordingController.state === "recording" ||
					recordingController.state === "warmup" ||
					recordingController.state === "finalizing"
				) {
					voiceDebug("Escape pressed → canceling voice");
					if (activeSession) {
						abortSession(activeSession);
						activeSession = null;
					}
					clearRecordingAnimTimer();
					clearWarmupWidget();
					hideWidget();
					if (statusTimer) {
						clearInterval(statusTimer);
						statusTimer = null;
					}
					recordingOwner?.cancel();
					activePreview?.abort();
					recordingController.begin();
					resetHoldState();
					playSound("error");
					setVoiceState("idle");
					lastEscapeTime = Date.now();
					return { consume: true };
				}

				// In idle: double-escape (two presses within 500ms) clears editor
				if (recordingController.state === "idle") {
					const now = Date.now();
					if (lastEscapeTime > 0 && now - lastEscapeTime < 500) {
						if (ctx?.hasUI) {
							const currentText = ctx.ui.getEditorText() || "";
							if (currentText.trim()) {
								ctx.ui.setEditorText("");
								lastEscapeTime = 0;
								return { consume: true };
							}
						}
					}
					lastEscapeTime = now;
				}
			}

			return undefined;
		});
	}

	// ─── Shortcuts ───────────────────────────────────────────────────────────

	// resolvedToggleShortcut is a runtime config string, but pi.registerShortcut
	// wants the literal-union KeyId type. The string was validated by
	// isValidShortcut() in loadGlobalToggleShortcut() (modifier+key shape with
	// a known modifier set), so asserting `as KeyId` is honest — `as any` was
	// strictly worse because it hid the intent and would have masked a real
	// signature change. If pi-tui later promotes KeyId to `string`, this
	// assertion just becomes a no-op.
	pi.registerShortcut(resolvedToggleShortcut as KeyId, {
		description: "Toggle voice recording (start/stop)",
		handler: async (handlerCtx) => {
			ctx = handlerCtx;
			if (!config.enabled) {
				handlerCtx.ui.notify("Voice disabled. Use /voice on", "warning");
				return;
			}
			if (dictationMode) {
				// The configured toggle shortcut stops dictation mode
				dictationMode = false;
				if (recordingController.state === "recording") {
					await stopVoiceRecording();
				}
				handlerCtx.ui.notify("Dictation mode stopped.", "info");
				return;
			}
			if (recordingController.state === "idle") {
				spaceConsumed = true;
				const ok = await startVoiceRecording();
				if (!ok) {
					spaceConsumed = false;
				}
			} else if (recordingController.state === "recording") {
				resetHoldState();
				await stopVoiceRecording();
			} else if (recordingController.state === "warmup") {
				// Cancel warmup
				clearWarmupWidget();
				hideWidget();
				resetHoldState();
				setVoiceState("idle");
			}
			// recordingController.state === "finalizing" → ignore (wait for transcript)
		},
	});

	// ─── Lifecycle ───────────────────────────────────────────────────────────

	pi.on("session_start", async (event, startCtx) => {
		// `event.reason` was added in pi-mono 0.65.0 ("startup" | "reload" | "new" |
		// "resume" | "fork"). Older Pi versions don't include it. Narrow defensively
		// so the same code typechecks against both 0.57-era and 0.65+ types.
		const reason = (event as { reason?: string } | undefined)?.reason ?? "startup";
		const isStartup = reason === "startup";

		// Non-startup transitions: pi-mono >= 0.68.0 fires session_shutdown first
		// (and awaits it), so voiceCleanup() has already run. This is just belt-
		// and-suspenders for older Pi versions that may skip session_shutdown on
		// session replacement. The try/catch matches session_shutdown — a throw
		// inside voiceCleanup (e.g. a child process kill EPERM under load) must
		// not abort handler execution and leave ctx unassigned.
		if (!isStartup) {
			try {
				voiceCleanup();
			} catch (err) {
				voiceDebug("voiceCleanup threw during session_start", { error: String(err) });
			}
		}

		ctx = startCtx;
		currentCwd = startCtx.cwd;
		const loaded = loadConfigWithSource(startCtx.cwd);
		if (config.localModel !== loaded.config.localModel || config.language !== loaded.config.language) {
			void finalPassClient.destroy();
		}
		config = loaded.config;
		configSource = loaded.source;
		// `/voice-punctuation status` reports the last decision of *this* session (spec §4.6).
		lastPunctuationDecision = null;

		// Both engines stay resident (spec §4.2): the recogniser as before, and the punctuation engine
		// built from the session's first moment, so no dictation ever waits for a background build.
		// A machine that has never fetched the model fetches it here — measured 285 MB on disk and
		// ~292 MB resident beside the recogniser's ~316 MB — which the one-time notice explains.
		// Measured: this call returns in 0.2 ms and the engine is usable within 100 ms.
		if (config.enabled && config.punctuationEnabled !== false && startCtx.hasUI) {
			preparePunctuation({ onTransfer: notifyPunctuationDownload });
		}

		// v7.1.3 — version banner emitted to debug log on every session
		// start. Lets users / support verify which extension build is
		// actually loaded after a `pi install .` (path-installed
		// extensions cache modules across `pi install` reinstalls — only
		// a fresh `pi` process picks up source changes).
		voiceDebug("pi-voicekit loaded", { reason });

		// Privacy cleanup, on EVERY start and before any early return below: a file written by 0.5.x may
		// still carry the retired backend credentials, and the product claims no audio is uploaded to a
		// remote speech service. Best-effort — the file may be unreadable, and that must not cost
		// dictation, exactly like the voiceCleanup guard at the top of this handler. The notice text is
		// built in config.ts (the one file allowed to name the retired keys); this handler only
		// displays it.
		try {
			const scrubbed = scrubRetiredVoiceKeys(getGlobalSettingsPath());
			if (scrubbed.message && startCtx.hasUI) startCtx.ui.notify(scrubbed.message, "info");
		} catch (err) {
			voiceDebug("retired credential scrub failed", { error: safeErrorText(err) });
			if (startCtx.hasUI) {
				startCtx.ui.notify(
					[
						"pi-voicekit could not read your settings file, so the retired speech-service credentials are still on disk.",
						`  ${safeErrorText(err)}`,
					].join("\n"),
					"warning"
				);
			}
		}

		// Migration / setup runs on EVERY session_start, regardless of reason.
		// Only the first-run notification is gated on isStartup.
		if (config.onboarding.completed) {
			// One-time post-upgrade notice (spec §4.6). Gated on a completed onboarding so a first
			// run shows its install hint alone; the flag then makes it a once-per-machine notice.
			maybeShowPunctuationUpgradeNotice(startCtx);
			// Always refresh the status bar — when voice is disabled,
			// updateVoiceStatus() clears the entry so users don't see stale
			// "MIC STREAM" text from a prior session. Hold-to-talk wiring
			// only runs when enabled.
			updateVoiceStatus();
			// The terminal input handler is registered whenever voice is enabled — its SPACE branch refuses
			// without a model, but F1 help and Escape (install cancel, playback stop) must keep working in
			// this state, which is exactly the one where the user is told to go and pick a model.
			if (config.enabled) {
				setupHoldToTalk();
			}
			// "Completed" is not "configured": the API-key backend is gone, so a config that finished
			// onboarding without a local model has no working path. Send its owner to the settings
			// panel instead of wiring hold-to-talk onto an implicit default model.
			if (!config.localModel) {
				if (isStartup && startCtx.hasUI) {
					startCtx.ui.notify(
						[
							"pi-voicekit needs a local model before it can dictate.",
							"",
							"  The API-key speech backend was removed in 0.6.0 — the key in your settings is not used.",
							"  Your settings are intact; choose a local model to start dictating.",
							"",
							"  Run /voice-setup to open the settings panel and choose a model.",
						].join("\n"),
						"warning"
					);
				}
			}
			return;
		}

		// Onboarding not complete. Bail before the migration / hint UI work if the
		// session has no UI surface — non-interactive sessions can't display
		// notifications anyway, and migration wiring (setupHoldToTalk) requires UI.
		if (!startCtx.hasUI) return;

		// Try migration if a local model is already configured. The activation predicate keys on the
		// model alone: the settings panel writes `localModel` and no longer writes any backend field,
		// so requiring one here would save a working config that never activates.
		const hasLocalModel = !!config.localModel;
		const audioTool = detectAudioCaptureTool();
		if (hasLocalModel) {
			// Local model configured — auto-activate. Migration runs every transition; the welcome
			// notification is gated on isStartup so /new and /resume don't re-spam the hint.
			config.onboarding.completed = true;
			config.onboarding.completedAt = new Date().toISOString();
			config.onboarding.source = "migration";
			saveConfig(config, config.scope === "project" ? "project" : "global", currentCwd, {
				loadedSource: configSource,
			});
			updateVoiceStatus();
			setupHoldToTalk();
			if (!isStartup) return;
			const modelLabel = LOCAL_MODELS.find((m) => m.id === config.localModel)?.name || config.localModel;
			const lines = [
				"pi-voicekit ready!",
				"",
				"  Hold SPACE to record → release to transcribe",
				`  ${toggleShortcutLabel} to toggle recording`,
				`  Local model: ${modelLabel} (offline, batch mode)`,
				`  Audio: ${audioTool ? `${audioTool.name}` : "NONE — install sox or ffmpeg"}`,
				"",
				"  /voice-settings to change model or language",
			];
			startCtx.ui.notify(lines.join("\n"), audioTool ? "info" : "warning");
			return;
		}

		// No local model yet — dictation refuses on its own, but the terminal input handler is still
		// registered so F1 help and Escape work before a model is chosen. Show the single-path install
		// hint only on actual startup.
		if (config.enabled) {
			setupHoldToTalk();
		}
		if (!isStartup) return;
		const lines = [
			"pi-voicekit installed — voice input for Pi",
			"",
			"  One path, fully offline:",
			"  • Local models — no API key, auto-downloads on first use",
			"",
			`  Audio capture: ${audioTool ? `${audioTool.name} ✓` : "not found — install sox or ffmpeg"}`,
			"",
			"  Run /voice-setup to open the settings panel and choose a model.",
		];
		startCtx.ui.notify(lines.join("\n"), "info");
	});

	pi.on("session_shutdown", async (event) => {
		// Synchronous teardown FIRST. Pi-mono >= 0.65.0 awaits the handler promise
		// before firing the replacement session_start, so the late-ctx-null race
		// the audit flagged is not present on current Pi. Keeping the order
		// (cleanup → null → await import) is still cheap insurance for older Pi
		// versions whose replacement path may not await. The try/catch is so a
		// throw inside voiceCleanup (e.g. a child process kill EPERM under load)
		// can't leak ctx or skip the recognizer cache clear.
		try {
			voiceCleanup();
		} catch (err) {
			voiceDebug("voiceCleanup threw during shutdown", { error: String(err) });
		}
		ctx = null;

		// Clear the sherpa recognizer cache ONLY on terminal quit. On older Pi
		// versions (< 0.65.0) shutdown handlers are not awaited before the
		// replacement session_start, so an `await import()` here can race with
		// the new session re-initializing the recognizer — and our late
		// clearRecognizerCache() would wipe the recognizer the new session just
		// created. Keeping the cache across non-quit transitions is also faster:
		// /reload, /new, /fork, /resume typically reuse the same model+language,
		// so the recognizer is still hot. Per-session language/model changes are
		// already invalidated in voice/settings-panel.ts when the user picks a
		// different model. Reason is undefined on pre-0.65 Pi (where shutdown
		// only ever fired on quit), so we treat undefined the same as "quit".
		const reason = (event as { reason?: string } | undefined)?.reason;
		if (reason === "quit" || reason === undefined) {
			await finalPassClient.destroy();
			try {
				const { clearRecognizerCache } = await import("./voice/sherpa-engine");
				clearRecognizerCache();
			} catch {}
		}
	});

	// Note: pi-mono < 0.65.0 fired a discrete "session_switch" event for
	// /new, /resume, /fork. That event was removed in 0.65.0 in favor of the
	// session_shutdown → session_start (with reason) flow handled above.
	// We don't register a shim here because package.json:peerDependencies
	// requires "@earendil-works/pi-coding-agent": "*", so a host without
	// the new flow can't install this extension in the first place.

	// ─── Auto-speak (TTS after assistant turn ends) ─────────────────────
	//
	// When ttsAutoSpeak is true AND ttsEnabled is true, subscribe to
	// `turn_end` and pipe the assistant's response through speak() with
	// the same text-filter and length-cap logic the manual command uses.
	//
	// The handler is always registered; it short-circuits when the flags
	// are off. This way toggling `ttsAutoSpeak` via /voice-speak-toggle
	// doesn't require a session restart.
	//
	// Rate limit: track the last auto-speak timestamp and skip if a new
	// turn ends within ~3 seconds. Prevents the agent's rapid-fire
	// short responses from queueing up unread audio.
	let lastAutoSpeakAt = 0;
	const AUTO_SPEAK_RATE_LIMIT_MS = 3000;

	// v7.2.1 — streaming auto-speak. Instead of waiting for `turn_end`
	// (which only fires AFTER the full response is generated), subscribe
	// to `message_update` and `message_end`:
	//   - message_update fires as the LLM streams tokens. We extract
	//     the accumulated text, find new sentence boundaries since
	//     the last speak, and queue those sentences for synthesis.
	//   - message_end flushes any remaining buffer (one final speak
	//     for trailing text without a sentence terminator).
	// Result: TTS starts speaking the FIRST sentence within ~1 second
	// of the agent producing it, instead of after the entire response
	// completes. Sentence chunking + pipelined synth (already in
	// speak.ts) keeps audio flowing continuously.
	//
	// Per-message tracking: each assistant message has its own
	// `spokenLen` cursor so concurrent messages (compaction, sub-turns)
	// don't cross-talk. Map keyed by message id.

	interface MessageStreamState {
		spokenLen: number; // chars of accumulated text already queued for speech
		pending: Promise<void>; // chain of in-flight speak() calls — serialize per message
	}
	const messageStreams = new Map<string, MessageStreamState>();

	const SENTENCE_TERMINATORS = /[.!?](?=\s|$)|[\n]{1,}/g;

	function extractAccumulatedText(message: any): string {
		if (!message || !Array.isArray(message.content)) return "";
		return (message.content as any[])
			.filter((c) => c?.type === "text" && typeof c.text === "string")
			.map((c) => c.text as string)
			.join("");
	}

	/** Detect last sentence boundary at or before `maxIdx` in `text`.
	 *  Returns the index AFTER the terminator (so [0..idx] is a complete
	 *  block). Returns -1 if none found. */
	function lastSentenceEnd(text: string, fromIdx: number): number {
		let lastEnd = -1;
		const re = /[.!?](?=\s|$)|\n+/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text)) !== null) {
			const end = m.index + m[0].length;
			if (end > fromIdx) lastEnd = end;
		}
		return lastEnd;
	}

	// Eager-speak threshold — if the buffered new text grows past this
	// many chars without a sentence terminator (e.g. very long
	// sentence mid-stream), speak what we have at the next clause
	// boundary (`,` `;` ` — `) or flush as-is. Keeps latency low for
	// long-winded responses.
	const EAGER_SPEAK_CHARS = 80;
	const EAGER_CLAUSE_RE = /[,;:—](?=\s)/g;

	function lastClauseEnd(text: string): number {
		let last = -1;
		EAGER_CLAUSE_RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = EAGER_CLAUSE_RE.exec(text)) !== null) {
			last = m.index + m[0].length;
		}
		return last;
	}

	async function maybeSpeakNew(messageId: string, fullText: string, isFinal: boolean): Promise<void> {
		if (!config.ttsEnabled || !config.ttsAutoSpeak) return;
		// Don't speak while STT is hot — feedback loop hazard.
		if (
			recordingController.state === "warmup" ||
			recordingController.state === "recording" ||
			recordingController.state === "finalizing"
		)
			return;
		if (!fullText) return;

		let state = messageStreams.get(messageId);
		if (!state) {
			state = { spokenLen: 0, pending: Promise.resolve() };
			messageStreams.set(messageId, state);
		}

		const newText = fullText.slice(state.spokenLen);
		if (!newText) return;

		let speakUpTo: number;
		if (isFinal) {
			// Flush everything remaining.
			speakUpTo = newText.length;
		} else {
			// Prefer sentence boundary; fall back to clause boundary
			// if we've buffered > EAGER_SPEAK_CHARS without one.
			const boundary = lastSentenceEnd(newText, 0);
			if (boundary > 0) {
				speakUpTo = boundary;
			} else if (newText.length >= EAGER_SPEAK_CHARS) {
				const clause = lastClauseEnd(newText);
				if (clause <= 0) return; // not even a clause yet — wait
				speakUpTo = clause;
			} else {
				return; // wait for more text
			}
		}

		const chunk = newText.slice(0, speakUpTo).trim();
		state.spokenLen += speakUpTo;
		if (!chunk) return;
		voiceDebug("autoSpeak.streaming", { id: messageId, chars: chunk.length, isFinal });

		// Strip code blocks / links / emojis / abbreviations to spoken form.
		const { prepareForSpeech } = await import("./voice/tts-text-filter");
		const prepared = prepareForSpeech(chunk, {
			maxChars: 2000,
			stripCodeBlocks: true,
			collapseLinks: true,
		});
		if (prepared.skipped || !prepared.text.trim()) return;

		// Serialize per-message: chain onto pending so chunks play in
		// order, never overlapping for the same message.
		const text = prepared.text;
		state.pending = state.pending.then(async () => {
			try {
				if (ctx) await runSpeak(ctx, text);
			} catch {
				// Auto-speak failures are non-blocking.
			}
		});
	}

	// Diagnostic: stream log shows when message_update / message_end
	// actually fire (some Pi versions don't emit message_update
	// per-token). Lets us verify the streaming path is alive.
	const streamDiag = (s: string) => {
		try {
			const fs2 = require("node:fs") as typeof import("node:fs");
			fs2.appendFileSync("/tmp/pi-listen-stream.log", `[${new Date().toISOString()}] ${s}\n`);
		} catch {
			/* best-effort */
		}
	};
	let mu_count = 0;
	pi.on("message_update", async (event) => {
		const msg = (event as any)?.message;
		if (!msg || msg.role !== "assistant") return;
		const id = (msg.id as string) || "current";
		const fullText = extractAccumulatedText(msg);
		mu_count++;
		if (mu_count <= 5 || mu_count % 10 === 0) {
			streamDiag(`message_update #${mu_count} id=${id} chars=${fullText.length}`);
		}
		await maybeSpeakNew(id, fullText, false);
	});

	pi.on("message_end", async (event) => {
		const msg = (event as any)?.message;
		if (!msg || msg.role !== "assistant") return;
		const id = (msg.id as string) || "current";
		const fullText = extractAccumulatedText(msg);
		streamDiag(`message_end id=${id} chars=${fullText.length} updates_seen=${mu_count}`);
		mu_count = 0;
		await maybeSpeakNew(id, fullText, true);
		// Drop the stream state once flushed — prevents unbounded growth.
		const state = messageStreams.get(id);
		if (state) {
			state.pending.finally(() => {
				if (messageStreams.get(id) === state) messageStreams.delete(id);
			});
		}
	});

	// Legacy turn_end fallback — only relevant on Pi versions that
	// don't fire message_update yet. Tracked via lastAutoSpeakAt so
	// it doesn't double-speak when message_update already covered the
	// content.
	pi.on("turn_end", async (event, _evtCtx) => {
		if (!config.ttsEnabled || !config.ttsAutoSpeak) return;
		const message = (event as any)?.message;
		if (!message || message.role !== "assistant") return;
		const id = (message.id as string) || "current";
		// If message_update already drained this message's stream
		// state, the streaming path handled it — skip.
		const state = messageStreams.get(id);
		if (state) return;
		if (
			recordingController.state === "warmup" ||
			recordingController.state === "recording" ||
			recordingController.state === "finalizing"
		)
			return;
		const now = Date.now();
		if (now - lastAutoSpeakAt < AUTO_SPEAK_RATE_LIMIT_MS) return;
		const text = extractAccumulatedText(message).trim();
		if (!text) return;
		const { prepareForSpeech } = await import("./voice/tts-text-filter");
		const prepared = prepareForSpeech(text, { maxChars: 2000, stripCodeBlocks: true, collapseLinks: true });
		if (prepared.skipped) return;
		lastAutoSpeakAt = now;
		try {
			if (ctx) await runSpeak(ctx, prepared.text);
		} catch {
			/* non-blocking */
		}
	});

	// ─── /voice command ──────────────────────────────────────────────────────

	pi.registerCommand("voice", {
		description: "Voice: /voice [on|off|stop|dictate|history|test|info|setup]",
		handler: async (args, cmdCtx) => {
			ctx = cmdCtx;
			const sub = (args || "").trim().toLowerCase();

			if (sub === "on") {
				config.enabled = true;
				updateVoiceStatus();
				setupHoldToTalk();
				const modelName = LOCAL_MODELS.find((m) => m.id === config.localModel)?.name || config.localModel;
				const enabledInfo = modelName
					? `Voice enabled (local model: ${modelName}).`
					: "Voice enabled — no local model selected yet. Run /voice-setup to choose one.";
				cmdCtx.ui.notify(
					[
						enabledInfo,
						"",
						"  Hold SPACE → release to transcribe",
						`  ${toggleShortcutLabel} → toggle recording on/off`,
						"  Quick SPACE tap → types a space (no voice)",
						"  Escape × 2 → clear editor",
						"",
						"  /voice-settings → open settings panel",
						"  /voice dictate  → continuous mode (no hold)",
						"  /voice test     → verify setup",
					].join("\n"),
					"info"
				);
				return;
			}

			if (sub === "off") {
				config.enabled = false;
				voiceCleanup();
				ctx.ui.setStatus("voice", undefined);
				cmdCtx.ui.notify("Voice disabled.", "info");
				return;
			}

			if (sub === "stop") {
				if (dictationMode) {
					dictationMode = false;
					if (recordingController.state === "recording") {
						await stopVoiceRecording();
					}
					cmdCtx.ui.notify("Dictation mode stopped.", "info");
				} else if (recordingController.state === "recording") {
					await stopVoiceRecording();
					cmdCtx.ui.notify("Recording stopped and transcribed.", "info");
				} else if (recordingController.state === "warmup") {
					clearWarmupWidget();
					hideWidget();
					resetHoldState();
					setVoiceState("idle");
					cmdCtx.ui.notify("Warmup cancelled.", "info");
				} else {
					cmdCtx.ui.notify("No recording in progress.", "info");
				}
				return;
			}

			// /voice dictate — continuous dictation mode

			if (sub === "dictate") {
				if (!config.enabled) {
					cmdCtx.ui.notify("Voice disabled. Use /voice on", "warning");
					return;
				}
				if (dictationMode) {
					cmdCtx.ui.notify("Already in dictation mode. /voice stop to end.", "info");
					return;
				}
				const starting = startVoiceRecording();
				const generation = recordingController.generation;
				const ok = await starting;
				if (!recordingController.owns(generation)) return;
				if (ok) {
					dictationMode = true;
					cmdCtx.ui.notify(
						[
							"🎤 Continuous dictation mode active.",
							"",
							"  Speak freely — no need to hold SPACE.",
							"  /voice stop → finalize and stop",
							`  ${toggleShortcutLabel} → also stops dictation`,
						].join("\n"),
						"info"
					);
				} else {
					dictationMode = false;
					cmdCtx.ui.notify("Failed to start dictation.", "error");
				}
				return;
			}

			// /voice history — show recent transcriptions
			if (sub === "history") {
				if (recordingHistory.length === 0) {
					cmdCtx.ui.notify("No recording history yet.", "info");
					return;
				}
				const lines = ["📜 Recent transcriptions:", ""];
				const show = recordingHistory.slice(0, 20);
				for (const entry of show) {
					const time = new Date(entry.timestamp).toLocaleTimeString();
					const dur = entry.duration.toFixed(1);
					const preview = entry.text.slice(0, 60) + (entry.text.length > 60 ? "…" : "");
					lines.push(`  ${time} (${dur}s): ${preview}`);
				}
				if (recordingHistory.length > 20) {
					lines.push(`  … and ${recordingHistory.length - 20} more`);
				}
				cmdCtx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (sub === "test") {
				cmdCtx.ui.notify("Testing voice setup…", "info");
				const tool = detectAudioCaptureTool();

				const lines = [
					"Voice diagnostics:",
					"",
					"  Engine: local, offline (batch mode)",
					"",
					"  Audio capture:",
					`    tool:              ${tool ? `${tool.name} (${tool.cmd})` : "NONE FOUND"}`,
				];
				if (!tool) {
					lines.push("    available:         sox ✗  ffmpeg ✗  arecord ✗");
					lines.push("    install one:       brew install sox (or ffmpeg)");
				}

				lines.push(`    local model:       ${config.localModel || "none selected — run /voice-setup"}`);
				lines.push("");
				lines.push("  Config:");
				lines.push(`    language:          ${config.language}`);
				lines.push(`    onboarding:        ${config.onboarding.completed ? "complete" : "incomplete"}`);
				lines.push(`    hold threshold:    ${getHoldThresholdMs()}ms`);
				lines.push(`    toggle shortcut:   ${resolvedToggleShortcut}`);
				lines.push(`    kitty protocol:    ${kittyReleaseDetected ? "detected" : "not detected"}`);
				lines.push(`    state:             ${recordingController.state}`);

				// Mic capture test using detected tool
				if (tool) {
					const testFile = path.join(os.tmpdir(), "pi-voice-test.wav");
					let testProc;
					if (tool.name === "sox") {
						testProc = spawn("rec", ["-q", "-r", "16000", "-c", "1", "-b", "16", "-d", "1", testFile], {
							stdio: "pipe",
						});
					} else if (tool.name === "ffmpeg") {
						const isMac = process.platform === "darwin";
						const isLinux = process.platform === "linux";
						let testInputArgs: string[];
						if (isMac) testInputArgs = ["-f", "avfoundation", "-i", ":default"];
						else if (isLinux) testInputArgs = ["-f", "pulse", "-i", "default"];
						else {
							const dshowDev = detectWindowsAudioDevice();
							testInputArgs = dshowDev
								? ["-f", "dshow", "-i", `audio=${dshowDev}`]
								: ["-f", "dshow", "-i", "audio=Microphone"];
						}
						const inputArgs = testInputArgs;
						testProc = spawn(
							"ffmpeg",
							[...inputArgs, "-t", "1", "-ar", "16000", "-ac", "1", "-y", "-loglevel", "error", testFile],
							{ stdio: "pipe" }
						);
					} else {
						testProc = spawn("arecord", ["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-d", "1", testFile], {
							stdio: "pipe",
						});
					}
					testProc.on("error", () => {});
					await new Promise<void>((resolve) => {
						let resolved = false;
						const done = () => {
							if (!resolved) {
								resolved = true;
								resolve();
							}
						};
						testProc.on("close", done);
						setTimeout(() => {
							try {
								testProc.kill();
							} catch {}
							done();
						}, 3000);
					});
					if (fs.existsSync(testFile)) {
						const size = fs.statSync(testFile).size;
						lines.push(`    mic capture:       OK (${size} bytes via ${tool.name})`);
						try {
							fs.unlinkSync(testFile);
						} catch {}
					} else {
						lines.push(`    mic capture:       FAILED — ${tool.name} ran but no audio captured`);
					}
				} else {
					lines.push("    mic capture:       skipped (no audio tool)");
				}

				// In-process sherpa-onnx mode — check module availability
				try {
					const { initSherpa, isSherpaAvailable } = await import("./voice/sherpa-engine");
					if (!isSherpaAvailable()) await initSherpa();
					const { isSherpaAvailable: checkAgain, getSherpaError } = await import("./voice/sherpa-engine");
					if (checkAgain()) {
						lines.push("    sherpa-onnx:       OK (in-process mode)");
					} else {
						lines.push(`    sherpa-onnx:       NOT AVAILABLE — ${getSherpaError() || "unknown"}`);
					}
				} catch (e: any) {
					lines.push(`    sherpa-onnx:       NOT AVAILABLE — ${e?.message || e}`);
				}

				// Summary
				lines.push("");
				// In-process sherpa-onnx mode — no server needed
				const ready = !!tool;
				if (!tool) {
					lines.push("  Setup needed — install any one of:");
					lines.push("    brew install sox       # macOS (recommended)");
					lines.push("    apt install sox        # Linux");
				} else {
					lines.push("  All checks passed — voice is ready (in-process sherpa-onnx)!");
					lines.push(`  Hold SPACE to record, or use ${toggleShortcutLabel} to toggle.`);
				}

				cmdCtx.ui.notify(lines.join("\n"), ready ? "info" : "warning");
				return;
			}

			// /voice language, /voice setup, /voice info → open settings panel
			if (sub === "language" || sub === "lang" || sub.startsWith("language ") || sub.startsWith("lang ")) {
				await openSettingsPanel(cmdCtx);
				return;
			}

			if (sub === "info" || sub === "setup" || sub === "reconfigure" || sub === "settings" || sub === "config") {
				await openSettingsPanel(cmdCtx);
				return;
			}

			// Default: toggle
			config.enabled = !config.enabled;
			if (!config.enabled) {
				voiceCleanup();
			} else {
				setupHoldToTalk();
			}
			updateVoiceStatus();
			cmdCtx.ui.notify(`Voice ${config.enabled ? "enabled" : "disabled"}.`, "info");
		},
	});

	// ─── /voice-setup → redirects to settings panel ─────────────────────────

	pi.registerCommand("voice-setup", {
		description: "Open pi-voicekit settings panel",
		handler: async (_args, cmdCtx) => openSettingsPanel(cmdCtx),
	});

	// ─── /voice-language → redirects to settings panel ───────────────────────

	pi.registerCommand("voice-language", {
		description: "Open pi-voicekit settings to change language",
		handler: async (_args, cmdCtx) => openSettingsPanel(cmdCtx),
	});

	// ─── /voice-help → v7.1 §11 keyboard / command reference ────────────────

	pi.registerCommand("voice-help", {
		description: "Show pi-voicekit keyboard + command reference",
		handler: async (_args, cmdCtx) => openHelpOverlay(cmdCtx),
	});

	async function openHelpOverlay(cmdCtx: ExtensionCommandContext): Promise<void> {
		if (!cmdCtx.hasUI) {
			cmdCtx.ui.notify("pi-voicekit: hold space=record · /voice-speak <text> · /voice-settings · /voice-help", "info");
			return;
		}
		const { HelpOverlay } = await import("./voice/ui-help-overlay");
		await cmdCtx.ui.custom<void>((_tui, theme, _kb, done) => new HelpOverlay({ theme }, done), {
			overlay: true,
			overlayOptions: { width: "70%", minWidth: 60, maxHeight: "80%", anchor: "center" },
		});
	}

	// ─── Settings panel (shared handler) ────────────────────────────────────

	async function openSettingsPanel(cmdCtx: ExtensionCommandContext, initialTab?: number) {
		ctx = cmdCtx;

		const { detectDevice, getModelFitness, formatDeviceSummary } = await import("./voice/device");
		const { getDownloadedModels, deleteModel, ensureModelDownloaded } = await import("./voice/model-download");
		const { isSherpaAvailable, clearRecognizerCache } = await import("./voice/sherpa-engine");
		const { VoiceSettingsPanel } = await import("./voice/settings-panel");
		type PanelAction = import("./voice/settings-panel").PanelAction;

		const device = detectDevice();
		// Construct the panel inside the custom() callback so the host theme
		// is in scope. Without this the panel falls back to raw ANSI which
		// clashes with non-default themes (Catppuccin Mocha etc.).
		const panelDeps = {
			config,
			device,
			cwd: currentCwd,
			getModelFitness,
			getDownloadedModels,
			deleteModel,
			isSherpaAvailable,
			formatDeviceSummary,
			saveConfig: (cfg: VoiceConfig, scope: VoiceSettingsScope, cwd: string) =>
				saveConfig(cfg, scope, cwd, { loadedSource: configSource }),
			clearRecognizerCache: () => {
				void finalPassClient.destroy();
				try {
					clearRecognizerCache();
				} catch {}
			},
		};

		let panel!: InstanceType<typeof VoiceSettingsPanel>;
		const result = await cmdCtx.ui.custom<PanelAction>(
			(_tui, theme, _kb, done) => {
				panel = new VoiceSettingsPanel({ ...panelDeps, theme }, initialTab);
				panel.onClose = (action) => done(action);
				return panel;
			},
			{
				overlay: true,
				overlayOptions: {
					width: "70%",
					minWidth: 44,
					maxHeight: "80%",
					anchor: "center",
				},
			}
		);

		// Post-close: handle the speak-test action by re-using the
		// /voice-speak-test command path. We do this AFTER the panel has
		// closed so the test sample plays without the picker overlay
		// interfering with the audio cue (Pi's terminal renderer paints
		// the panel as an overlay; closing it first gives a clean
		// playback experience).
		if (result?.type === "speak-test") {
			await runSpeak(cmdCtx, "The quick brown fox jumps over the lazy dog.", { forceEnabled: true });
			return;
		}

		// Post-close: handle the TTS install action triggered by selecting
		// a not-yet-installed model in the Speak tab Model picker.
		// v7.1: surfaces progress through the new sticky install widget
		// (`tts-install-progress.ts`) keyed by modelId so concurrent
		// installs of different models coexist without slot collision.
		if (result?.type === "tts-install" && result.modelId) {
			const { ensureTtsModelInstalled, getTtsModel } = await import("./voice/tts-local-models");
			const model = getTtsModel(result.modelId);
			// runInstallWithWidget rethrows on failure (Codex v6 #2) so
			// callers like runSpeak can short-circuit. This call site is
			// terminal — no further work — so swallow the rethrow after
			// notifications were already emitted by the helper itself.
			try {
				await runInstallWithWidget(cmdCtx, model.id, model.name, model.sizeBytes ?? 0, ensureTtsModelInstalled);
			} catch {
				/* notify already emitted in runInstallWithWidget */
			}
			return;
		}

		// Post-close: handle download action with full pre-checks + progress
		if (result?.type === "download" && result.modelId) {
			const model = LOCAL_MODELS.find((m) => m.id === result.modelId);
			if (model) {
				const { checkDownloadPrereqs, createProgressTracker, verifyDownload, formatBytes } = await import(
					"./voice/model-download"
				);
				const { initSherpa, isSherpaAvailable, getSherpaError } = await import("./voice/sherpa-engine");

				// ── Step 1: Check sherpa-onnx dependency ──
				if (!isSherpaAvailable()) {
					cmdCtx.ui.notify("Initializing sherpa-onnx runtime…", "info");
					const ok = await initSherpa();
					if (!ok) {
						cmdCtx.ui.notify(
							[
								"sherpa-onnx is required for local models but failed to initialize.",
								`Error: ${getSherpaError() || "unknown"}`,
								"",
								"To fix:",
								"  1. Ensure sherpa-onnx-node is installed: bun add sherpa-onnx-node",
								"  2. Check platform compatibility (see the error above: 64-bit macOS/Linux/Windows x64)",
								"  3. Then retry the download from /voice-models",
							].join("\n"),
							"error"
						);
						return;
					}
				}

				// ── Step 2: Pre-download checks (disk, network, permissions) ──
				cmdCtx.ui.notify(`Checking prerequisites for ${model.name} (${model.size})…`, "info");
				const preCheck = await checkDownloadPrereqs(model.sherpaModel.downloadUrls, model.sizeBytes);
				if (!preCheck.ok) {
					cmdCtx.ui.notify(
						[
							`Cannot download ${model.name}:`,
							"",
							...preCheck.issues.map((i) => `  • ${i}`),
							"",
							"Resolve the above and try again via /voice-models.",
						].join("\n"),
						"error"
					);
					return;
				}

				// ── Step 3: Download with real-time progress ──
				const tracker = createProgressTracker(model.name);
				cmdCtx.ui.notify(`Starting download: ${model.name} (${model.size})…`, "info");

				try {
					await ensureModelDownloaded(model.id, model.sherpaModel.downloadUrls, model.sizeBytes, (raw) => {
						const rich = tracker(raw);
						if (rich) cmdCtx.ui.notify(rich.line, "info");
					});
				} catch (err: any) {
					const msg = err?.message || String(err);
					const lines = [`Download failed: ${model.name}`];
					if (msg.includes("timed out") || msg.includes("Timeout")) {
						lines.push("The download timed out. Check your internet speed and try again.");
					} else if (msg.includes("ENOSPC") || msg.includes("no space")) {
						lines.push("Disk is full. Free up space and try again.");
					} else if (msg.includes("HTTP 4") || msg.includes("HTTP 5")) {
						lines.push(`Server error: ${msg}`);
						lines.push("The model server may be temporarily down. Try again in a few minutes.");
					} else {
						lines.push(`Error: ${msg}`);
					}
					lines.push("", "Partial downloads are auto-resumed on next attempt.");
					cmdCtx.ui.notify(lines.join("\n"), "error");
					return;
				}

				// ── Step 4: Post-download verification ──
				const verification = verifyDownload(model.id, model.sherpaModel.downloadUrls, model.sizeBytes);
				if (!verification.ok) {
					cmdCtx.ui.notify(
						[
							`${model.name} downloaded but verification failed:`,
							"",
							...verification.issues.map((i) => `  • ${i}`),
							"",
							"Try: /voice-models → Downloaded tab → delete and re-download.",
						].join("\n"),
						"warning"
					);
					return;
				}

				cmdCtx.ui.notify(`${model.name} downloaded and verified (${model.size}). Ready to use.`, "info");
			}
		}

		// Sync voice state after panel changes. The terminal input handler is registered in every
		// configuration — F1 help and Escape (install cancel, playback stop) must work with no model chosen
		// — so a missing model only disarms dictation. `voiceCleanup` here would cancel in-flight installs,
		// stop speech playback and drop every widget: work the user started for another reason, torn down
		// because dictation has nothing to record with. Full teardown belongs to a disabled voice.
		if (config.enabled) {
			setupHoldToTalk();
			if (!config.localModel) disarmDictation();
		} else {
			voiceCleanup();
		}
		updateVoiceStatus();
	}

	// ─── TTS commands (v6.0.0+) ─────────────────────────────────────────
	//
	// The active speech AbortController lives at extension scope so
	// `/voice-speak-stop` can cancel whatever is currently playing.
	// Re-entrant `/voice-speak` calls abort the prior one before starting
	// (no overlapping audio); `null` means nothing is in-flight.
	let activeSpeak: AbortController | null = null;

	function abortActiveSpeak(): boolean {
		if (!activeSpeak) return false;
		try {
			activeSpeak.abort();
		} catch {}
		activeSpeak = null;
		return true;
	}

	/**
	 * v7.1: run an install with the new sticky `TtsInstallProgressWidget`.
	 * Replaces the v7.0.x notify-spam loop. Mounts a per-model-id slot
	 * (`installWidgetKey(modelId)`) so two concurrent installs for
	 * different models coexist without clobbering. The widget owns its
	 * own AbortController (currently abort-only via cancel()); the
	 * existing in-flight Map in `ensureTtsModelInstalled` serializes
	 * same-id calls.
	 */
	async function runInstallWithWidget(
		cmdCtx: ExtensionCommandContext | ExtensionContext,
		modelId: string,
		modelName: string,
		totalBytesEstimate: number,
		ensureTtsModelInstalled: (
			id: string,
			opts: { signal?: AbortSignal; onProgress?: (info: any) => void }
		) => Promise<unknown>,
		// godspeed architect finding: accept caller signal so
		// /voice-speak-stop or TTS-disable propagates into the install.
		// Caller's signal cascades: aborting it triggers our own
		// AbortController and tears down the widget cleanly.
		callerSignal?: AbortSignal
	): Promise<void> {
		if (!cmdCtx.hasUI) {
			// Headless / scripted mode — fall back to a single notify so
			// users running pi without a TUI still get progress feedback.
			cmdCtx.ui.notify(`Installing ${modelName}…`, "info");
			try {
				await ensureTtsModelInstalled(modelId, {});
				cmdCtx.ui.notify(`${modelName} ready.`, "info");
			} catch (err: any) {
				// Codex v6.5: rethrow so callers like runSpeak short-
				// circuit instead of proceeding with a model that
				// isn't installed. Match the TUI branch's
				// `__alreadyNotified` contract so the outer catch
				// doesn't emit a duplicate notify.
				if (err?.name === "AbortError") {
					cmdCtx.ui.notify(`Install cancelled: ${modelName}`, "warning");
				} else {
					cmdCtx.ui.notify(`Install failed: ${err?.message ?? err}`, "error");
				}
				if (err && typeof err === "object") {
					try {
						(err as any).__alreadyNotified = true;
					} catch {
						/* frozen errors */
					}
				}
				throw err;
			}
			return;
		}

		const { registry, ticker } = getOrInitVoiceUi();
		const controller = new AbortController();
		// Cascade caller signal → controller. If runSpeak's activeSpeak
		// signal aborts (user runs /voice-speak-stop or disables TTS),
		// the install cancels too. Listener removed in finally.
		let callerAbortListener: (() => void) | null = null;
		if (callerSignal) {
			if (callerSignal.aborted) {
				try {
					controller.abort();
				} catch {}
			} else {
				callerAbortListener = () => {
					try {
						controller.abort();
					} catch {}
				};
				callerSignal.addEventListener("abort", callerAbortListener);
			}
		}
		const widget = new TtsInstallProgressWidget({
			ui: cmdCtx.ui,
			modelId,
			modelName,
			totalBytesEstimate,
			registry,
			ticker,
			controller,
		});
		activeInstallWidgets.set(modelId, widget);
		try {
			await ensureTtsModelInstalled(modelId, {
				signal: controller.signal,
				onProgress: (info) => widget.onProgress(info),
			});
			// Widget self-disposes on phase=done; if ensure resolved
			// without firing done (very unlikely), make sure cleanup
			// runs anyway.
			widget.dispose();
			cmdCtx.ui.notify(`${modelName} ready.`, "info");
		} catch (err: any) {
			widget.dispose();
			// Codex v6 finding #2: rethrow so the caller (e.g. runSpeak)
			// can short-circuit instead of proceeding into speak() with
			// a model that isn't installed. We notify once here with the
			// install context; the rethrown error will be caught by the
			// caller's outer try/catch but tagged with `__alreadyNotified`
			// so the caller can skip its generic notify.
			if (err?.name === "AbortError") {
				cmdCtx.ui.notify(`Install cancelled: ${modelName}`, "warning");
			} else {
				cmdCtx.ui.notify(`Install failed: ${err?.message ?? err}`, "error");
			}
			if (err && typeof err === "object") {
				try {
					(err as any).__alreadyNotified = true;
				} catch {
					/* frozen errors */
				}
			}
			throw err;
		} finally {
			// Codex v6 finding #4: owner-checked delete so an older
			// finally cannot evict a newer same-id widget. (The
			// in-flight Map in ensureTtsModelInstalled already serializes
			// same-id installs, but the side-table here doesn't piggy-
			// back on that guarantee — defensive owner check.)
			if (activeInstallWidgets.get(modelId) === widget) {
				activeInstallWidgets.delete(modelId);
			}
			// Always remove the caller-signal listener.
			if (callerAbortListener && callerSignal) {
				try {
					callerSignal.removeEventListener("abort", callerAbortListener);
				} catch {}
			}
		}
	}

	async function runSpeak(
		cmdCtx: ExtensionCommandContext | ExtensionContext,
		text: string,
		opts: { forceEnabled?: boolean } = {}
	): Promise<void> {
		// `forceEnabled` lets /voice-speak-test bypass the gate without
		// mutating shared config. The previous mutate-snapshot-restore
		// pattern raced against /voice-speak-toggle and could clobber the
		// user's explicit toggle.
		if (!config.ttsEnabled && !opts.forceEnabled) {
			cmdCtx.ui.notify("TTS is disabled. Enable in /voice-settings.", "warning");
			return;
		}
		if (recordingController.state === "recording" || recordingController.state === "finalizing") {
			// Speaking while the mic is hot would feedback into STT.
			cmdCtx.ui.notify("Cannot speak while recording. Stop recording first.", "warning");
			return;
		}

		// Cancel any in-flight speech so the new request takes the floor.
		abortActiveSpeak();
		const controller = new AbortController();
		activeSpeak = controller;

		try {
			const { speak } = await import("./voice/speak");
			const { getInstalledTtsModelDir, ensureTtsModelInstalled, getTtsModel } = await import(
				"./voice/tts-local-models"
			);

			// Fetch the model on demand if it is missing. v7.1: surface
			// progress through the sticky install widget instead of the
			// v7.0.x notify-spam loop.
			const modelId = config.ttsLocalModel || DEFAULT_TTS_LOCAL_MODEL;
			try {
				getInstalledTtsModelDir(modelId);
			} catch {
				const model = getTtsModel(modelId);
				await runInstallWithWidget(
					cmdCtx,
					modelId,
					model.name,
					model.sizeBytes ?? 0,
					ensureTtsModelInstalled,
					controller.signal
				);
			}

			// v7.1: mount the honest playback indicator (§6 of plan).
			// Spinner + state word with no fake amplitude meter. Until
			// `speak()` exposes a phase callback (v7.2), the indicator
			// stays on "playing" for the whole synth+play cycle —
			// honest because audio IS in flight throughout. Disposed
			// in finally regardless of success/abort/error. Tracked
			// on `activePlaybackIndicator` so the [esc] router can
			// stop playback when no install widget owns escape.
			let indicator: TtsPlaybackIndicator | null = null;
			if (cmdCtx.hasUI) {
				const { registry, ticker } = getOrInitVoiceUi();
				indicator = new TtsPlaybackIndicator({
					ui: cmdCtx.ui,
					registry,
					ticker,
					onStop: () => abortActiveSpeak(),
				});
				indicator.setState("playing");
				activePlaybackIndicator = indicator;
			}
			try {
				await speak({
					text,
					config,
					signal: controller.signal,
					resolveModelDir: (id) => getInstalledTtsModelDir(id),
				});
			} finally {
				indicator?.setState("idle"); // self-disposes
				// Owner-checked clear, mirroring runInstallWithWidget's
				// Codex v6 #4 fix.
				if (activePlaybackIndicator === indicator) activePlaybackIndicator = null;
			}
		} catch (err: any) {
			if (err?.name === "AbortError") return;
			// If the install widget already notified the user with a
			// scoped message ("Install failed: <model>"), don't emit a
			// duplicate generic "Speak failed:" notify. The install
			// widget's notify is more informative for that path.
			if (!err?.__alreadyNotified) {
				cmdCtx.ui.notify(`Speak failed: ${err?.message ?? err}`, "error");
			}
		} finally {
			if (activeSpeak === controller) activeSpeak = null;
		}
	}

	pi.registerCommand("voice-speak", {
		description: "Speak the given text (text-to-speech)",
		handler: async (args, cmdCtx) => {
			ctx = cmdCtx;
			const text = (args || "").trim();
			if (!text) {
				cmdCtx.ui.notify("Usage: /voice-speak <text>", "warning");
				return;
			}
			await runSpeak(cmdCtx, text);
		},
	});

	// v7.1.3 — tune the hold-to-talk activation delay.
	pi.registerCommand("voice-hold-delay", {
		description: "Set hold-to-talk delay in ms (200-3000, default 700)",
		handler: async (args, cmdCtx) => {
			ctx = cmdCtx;
			const trimmed = (args || "").trim();
			if (!trimmed) {
				cmdCtx.ui.notify(`Hold delay: ${getHoldThresholdMs()}ms (default 700)`, "info");
				return;
			}
			const ms = parseInt(trimmed, 10);
			if (!Number.isFinite(ms) || ms < 200 || ms > 3000) {
				cmdCtx.ui.notify(`Invalid value: ${trimmed}. Must be 200-3000 ms.`, "warning");
				return;
			}
			(config as any).holdThresholdMs = ms;
			saveConfig(config, config.scope === "project" ? "project" : "global", currentCwd, { loadedSource: configSource });
			cmdCtx.ui.notify(`Hold delay set to ${ms}ms.`, "info");
		},
	});

	// Read-only diagnostics for the offline punctuation step (spec §4.6): the switch, the model's
	// state, and what happened on the last dictation of this session. The switch itself is a
	// config field (`voice.punctuationEnabled`) — this command never writes.
	pi.registerCommand("voice-punctuation", {
		description: "Voice: /voice-punctuation status — offline punctuation state and last decision",
		handler: async (args, cmdCtx) => {
			ctx = cmdCtx;
			const verb = (args || "").trim().toLowerCase();
			if (verb && verb !== "status") {
				cmdCtx.ui.notify("Usage: /voice-punctuation status", "warning");
				return;
			}
			cmdCtx.ui.notify(punctuationStatusReport(), "info");
		},
	});

	pi.registerCommand("voice-speak-stop", {
		description: "Stop in-flight TTS playback",
		handler: async (_args, cmdCtx) => {
			ctx = cmdCtx;
			if (abortActiveSpeak()) {
				cmdCtx.ui.notify("Speech stopped.", "info");
			} else {
				cmdCtx.ui.notify("No active speech.", "info");
			}
		},
	});

	pi.registerCommand("voice-speak-toggle", {
		description: "Toggle TTS on/off (master switch)",
		handler: async (_args, cmdCtx) => {
			ctx = cmdCtx;
			const nowEnabling = !config.ttsEnabled;
			config.ttsEnabled = nowEnabling;
			saveConfig(config, config.scope === "project" ? "project" : "global", currentCwd, { loadedSource: configSource });
			if (!nowEnabling) abortActiveSpeak();
			cmdCtx.ui.notify(`TTS ${nowEnabling ? "enabled" : "disabled"}.`, "info");
			// First-time enable → v7.1 §9 rich onboarding overlay with
			// three explicit actions (try / pick model / skip).
			// Subsequent toggles are silent.
			if (nowEnabling && !(config as any).ttsOnboardingShown && cmdCtx.hasUI) {
				try {
					const { detectDevice } = await import("./voice/device");
					const { TtsOnboardingOverlay } = await import("./voice/tts-onboarding-overlay");
					const device = detectDevice();
					// §9: persist `ttsOnboardingShown = true` BEFORE any
					// async work so a failed install/cancel never re-prompts.
					(config as any).ttsOnboardingShown = true;
					saveConfig(config, config.scope === "project" ? "project" : "global", currentCwd, {
						loadedSource: configSource,
					});

					const result = await cmdCtx.ui.custom<import("./voice/tts-onboarding-overlay").OnboardingResult>(
						(_tui, theme, _kb, done) => {
							return new TtsOnboardingOverlay({ systemLocale: device.systemLocale, theme }, done);
						},
						{
							overlay: true,
							overlayOptions: { width: "70%", minWidth: 60, maxHeight: "60%", anchor: "center" },
						}
					);
					if (result?.kind === "test") {
						await runSpeak(cmdCtx, "The quick brown fox jumps over the lazy dog.", { forceEnabled: true });
					} else if (result?.kind === "pickModel") {
						// Open the settings panel directly on the Speak tab.
						// Tab order is general/models/downloaded/speak/device → idx 3.
						await openSettingsPanel(cmdCtx, 3);
					}
				} catch (err) {
					voiceDebug("onboarding overlay threw", String(err));
				}
			} else if (nowEnabling && !cmdCtx.hasUI) {
				// Headless mode — fall back to the v7.0 notify-based hint.
				try {
					const { detectDevice } = await import("./voice/device");
					const { maybeShowTtsOnboarding } = await import("./voice/tts-onboarding");
					maybeShowTtsOnboarding({
						ctx: cmdCtx,
						config,
						device: detectDevice(),
						cwd: currentCwd,
						saveConfig: (cfg, scope, cwd) => saveConfig(cfg, scope, cwd, { loadedSource: configSource }),
					});
				} catch {
					/* onboarding hint is best-effort */
				}
			}
		},
	});

	pi.registerCommand("voice-speak-test", {
		description: "Synthesize a sample sentence in the current voice",
		handler: async (_args, cmdCtx) => {
			ctx = cmdCtx;
			// Pass forceEnabled so the test runs even when ttsEnabled is
			// false — without mutating shared config (a concurrent
			// /voice-speak-toggle would otherwise be clobbered when the
			// test's finally restored its snapshot).
			await runSpeak(cmdCtx, "The quick brown fox jumps over the lazy dog.", { forceEnabled: true });
		},
	});

	pi.registerCommand("voice-speak-info", {
		description: "Show TTS configuration: model, voice, install state",
		handler: async (_args, cmdCtx) => {
			ctx = cmdCtx;
			const { getTtsModel, isTtsModelInstalled, TTS_LOCAL_MODELS } = await import("./voice/tts-local-models");

			const lines: string[] = ["TTS configuration:", ""];
			lines.push(`  Enabled:      ${config.ttsEnabled ? "yes" : "no"}`);
			lines.push(`  Language:     ${config.ttsLanguage ?? config.language ?? "en"}`);
			lines.push(`  Speed:        ${(config.ttsSpeed ?? 1.0).toFixed(2)}x`);
			lines.push(`  Auto-speak:   ${config.ttsAutoSpeak ? "yes" : "no"}`);
			lines.push("");

			const modelId = config.ttsLocalModel ?? DEFAULT_TTS_LOCAL_MODEL;
			let model;
			try {
				model = getTtsModel(modelId);
			} catch {
				model = undefined;
			}
			const installed = isTtsModelInstalled(modelId);
			lines.push("  Local TTS:");
			lines.push(`    Model:      ${modelId}${model ? ` (${model.name}, ${model.size})` : " — unknown id"}`);
			lines.push(`    Installed:  ${installed ? "yes" : "NO — first speak will download"}`);
			if (model) {
				const sid = typeof config.ttsLocalVoiceId === "number" ? config.ttsLocalVoiceId : model.defaultSid;
				const voice = model.voices.find((v) => v.sid === sid);
				lines.push(`    Voice sid:  ${sid}${voice ? ` (${voice.name})` : ""}`);
				lines.push(`    Languages:  ${model.languages.join(", ")}`);
				lines.push(`    Sample rate: ${model.sampleRate} Hz`);
			}
			lines.push("");
			lines.push(`  Catalog:      ${TTS_LOCAL_MODELS.length} models available — /voice-speak-models to browse`);

			lines.push("");
			lines.push("  Commands: /voice-speak <text>  ·  /voice-speak-stop  ·  /voice-speak-toggle");
			lines.push("            /voice-speak-test    ·  /voice-speak-models  ·  /voice-settings");
			cmdCtx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("voice-speak-models", {
		description: "Browse and install TTS models (opens settings panel on Speak tab)",
		// initialTab=3 → Speak tab (index 0=General, 1=Models, 2=Downloaded, 3=Speak, 4=Device)
		handler: async (_args, cmdCtx) => openSettingsPanel(cmdCtx, 3),
	});

	// ─── /voice-settings — unified pi-voicekit settings panel ─────────────

	pi.registerCommand("voice-settings", {
		description: "Open pi-voicekit settings — models, language, device",
		handler: async (_args, cmdCtx) => openSettingsPanel(cmdCtx),
	});

	// ─── /voice-models — opens settings panel on Models tab ─────────────

	pi.registerCommand("voice-models", {
		description: "Manage local voice models (opens settings panel)",
		handler: async (_args, cmdCtx) => openSettingsPanel(cmdCtx, 1),
	});
}
