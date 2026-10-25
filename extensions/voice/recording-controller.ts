import type { VoiceConfig } from "./config.ts";
import type { SinkResult } from "./editor-sink.ts";
import type { FinalPassClient } from "./final-pass-client.ts";
import type { startLocalSession, stopLocalSession, abortLocalSession } from "./local.ts";
import type { PreviewClient } from "./preview-worker-client.ts";

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

/** Ports only in Task 6. State and generation ownership move together in Task 7. */
export interface RecordingControllerDeps {
	now(): number;
	getConfig(): VoiceConfig;
	ui: RecordingUiPort;
	preview: PreviewClient;
	finalPass: FinalPassClient;
	capture: {
		start: typeof startLocalSession;
		stop: typeof stopLocalSession;
		abort: typeof abortLocalSession;
	};
}

export interface RecordingController {
	start(mode: "hold" | "dictate"): Promise<boolean>;
	stop(): Promise<void>;
	cancel(): void;
	dispose(): Promise<void>;
	readonly state: VoiceState;
	readonly previewText: string;
}
