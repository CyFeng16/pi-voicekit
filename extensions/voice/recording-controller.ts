import type { SinkResult } from "./editor-sink.ts";

export type VoiceState = "idle" | "warmup" | "recording" | "finalizing";

/** Rendering and delivery ports; editor insertion belongs to the composition, not the presenter. */
export interface RecordingUiPort {
	mountPanel(getText: () => string): void;
	unmountPanel(): void;
	mountRecordingIndicator(): void;
	unmountRecordingIndicator(): void;
	renderRecordingFrame(): void;
	mountWarmupIndicator(): void;
	unmountWarmupIndicator(): void;
	renderWarmupFrame(): void;
	insert(text: string): SinkResult;
	notify(message: string, level: "info" | "warning" | "error"): void;
	playSound(kind: "start" | "stop" | "error"): void;
	setState(state: VoiceState): void;
	setAudioLevel(level: number): void;
	setProgress(elapsedMs: number, holdThresholdMs: number): void;
}

/**
 * State ownership only. Lifecycle ports (clock, config, UI, preview, final pass, capture) are
 * injected when the controller really starts and stops recordings; today it needs the transition log.
 */
export interface RecordingControllerDeps {
	debug(message: string, context?: Record<string, unknown>): void;
}

export interface RecordingController {
	readonly state: VoiceState;
	setState(next: VoiceState): void;
}

/**
 * Single owner of the recording state value. The caller keeps the consequences of a transition
 * (shared globals, status refresh); the controller keeps the value and its debug breadcrumb.
 */
export function createRecordingController(deps: RecordingControllerDeps): RecordingController {
	let state: VoiceState = "idle";
	return {
		get state() {
			return state;
		},
		setState(next) {
			const prev = state;
			state = next;
			if (prev !== next) deps.debug(`STATE: ${prev} → ${next}`);
		},
	};
}
