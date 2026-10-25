import type { Theme } from "@earendil-works/pi-coding-agent";
import type { RecordingUiPort } from "./recording-controller.ts";
import { createPreviewPanel, type PreviewPanel } from "./preview-panel.ts";
import { BaseDisposableWidget, type WidgetRegistry } from "./ui-widget-base.ts";

export type WidgetFactory = (tui: { requestRender(): void }, theme: Pick<Theme, "fg">) => PreviewPanel;

export interface PresenterDeps {
	registry(): WidgetRegistry;
	hasUI(): boolean;
	now(): number;
	getHoldThresholdMs(): number;
	getRecordingStart(): number;
	getAudioLevel?(): number;
	setWidget(key: string, widget: WidgetFactory | undefined, opts?: { placement?: "aboveEditor" | "belowEditor" }): void;
	/** Returns an idempotent cancellation function. Cadences are deliberately not the preview ticker. */
	schedule(frame: () => void, ms: number): () => void;
	setState: RecordingUiPort["setState"];
	notify: RecordingUiPort["notify"];
	playSound: RecordingUiPort["playSound"];
	debug(message: string, context?: Record<string, unknown>): void;
}

export type RecordingPresenter = Omit<RecordingUiPort, "insert"> & {
	stopWarmupAnimation(): void;
	stopRecordingAnimation(): void;
	hideIndicator(): void;
	dispose(): void;
};

/** Owns visible widgets only; state transitions and preview lifecycle remain with the caller. */
export function createRecordingPresenter(deps: PresenterDeps): RecordingPresenter {
	let indicator: OwnedWidget | undefined;
	let panel: OwnedWidget | undefined;
	let handingOver = false;
	let warmupStart = 0;
	let progress: number | undefined;
	let audioLevel: number | undefined;
	let stopWarmup: (() => void) | undefined;
	let stopRecording: (() => void) | undefined;

	class OwnedWidget extends BaseDisposableWidget {
		constructor(
			readonly key: string,
			private readonly cleanup: () => void
		) {
			super(deps.registry(), () => {
				if (!handingOver && deps.hasUI()) clearSlot(key);
			});
		}
		protected onDispose(): void {
			this.cleanup();
		}
	}

	function clearSlot(key: string): void {
		try {
			deps.setWidget(key, undefined);
		} catch (error) {
			deps.debug("hideWidget threw", { error: String(error) });
		}
	}
	function stopWarmupAnimation(): void {
		stopWarmup?.();
		stopWarmup = undefined;
	}
	function stopRecordingAnimation(): void {
		stopRecording?.();
		stopRecording = undefined;
	}
	function ownIndicator(cleanup: () => void): void {
		const owner = new OwnedWidget("voice-recording", () => {
			cleanup();
			if (indicator === owner) indicator = undefined;
		});
		handingOver = true;
		try {
			deps.registry().register(owner);
		} finally {
			handingOver = false;
		}
		indicator = owner;
	}
	function unmountIndicator(): void {
		indicator?.dispose();
	}

	function mountWarmupIndicator(): void {
		if (!deps.hasUI()) return;
		ownIndicator(stopWarmupAnimation);
		warmupStart = deps.now();
		progress = undefined;
		renderWarmupFrame();
		stopWarmup = deps.schedule(renderWarmupFrame, 90);
	}
	function mountRecordingIndicator(): void {
		if (!deps.hasUI()) return;
		stopWarmupAnimation();
		ownIndicator(stopRecordingAnimation);
		stopRecording = deps.schedule(renderRecordingFrame, 150);
		renderRecordingFrame();
	}

	function getRecordDot(): string {
		// v7.2 — soft pulse between full and dim. Two-state instead of
		// three-state (cleaner, more like a breathing LED indicator
		// than the v7.0 multi-glyph approach).
		const phase = (Math.sin(deps.now() / 700) + 1) / 2;
		return phase > 0.5 ? "●" : "○";
	}

	function buildAuroraWave(level: number, cells = 16): string {
		// Generate 2*cells audio "samples" via multi-frequency sine
		// + the live RMS energy. Same organic motion as the legacy
		// wave but at higher density.
		const samples = 2 * cells;
		const t = deps.now() / 1000;
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
		const { liquidBraille, auroraColor } = require("./ui-aura") as typeof import("./ui-aura");
		return liquidBraille(arr, auroraColor);
	}

	function renderWarmupFrame() {
		if (!deps.hasUI()) return;
		const currentProgress = progress ?? Math.min((deps.now() - warmupStart) / deps.getHoldThresholdMs(), 1);
		deps.setWidget(
			"voice-recording",
			(_tui, theme) => {
				return {
					invalidate() {},
					render(width: number): string[] {
						// v7.2 world-class — Same Floating Island chrome
						// as the active recording widget, with the
						// progress bar inside. Establishes visual
						// continuity between warmup → recording (same
						// island, content shifts, no jump).
						const { island, auroraColor, titleBreathe } = require("./ui-aura") as typeof import("./ui-aura");
						const dim = (s: string) => theme.fg("dim", s);
						const muted = (s: string) => theme.fg("muted", s);
						const accent = (s: string) => theme.fg("accent", s);
						const islandW = Math.max(36, Math.min(46, width - 2));

						// Aurora gradient progress: ▰ filled / ▱ empty
						// with truecolor across the filled portion.
						const innerW = islandW - 2;
						const fixedW = 3 /* " ○ " */ + 1; /* trail */
						const meterCells = Math.max(12, innerW - fixedW);
						const filled = Math.round(currentProgress * meterCells);
						let bar = "";
						for (let i = 0; i < meterCells; i++) {
							if (i < filled) {
								// Color stop based on position along filled portion.
								const t = filled === 0 ? 0 : i / Math.max(1, meterCells - 1);
								bar += auroraColor(t) + "▰";
							} else {
								bar += dim("▱");
							}
						}
						bar += "\x1b[0m";

						const dot = currentProgress < 1 ? muted("○") : accent("●");
						const content = ` ${dot} ${bar} `;
						// Breathing title — same aurora-cycle as recording widget
						// so the warmup → recording transition feels seamless.
						const titleStyled = titleBreathe(deps.now()) + "\x1b[1mVoice Mode\x1b[0m";
						const footer = currentProgress < 1 ? dim("hold to record") : accent("ready");
						return island({ width: islandW, title: titleStyled, content, footer, dim });
					},
				};
			},
			{ placement: "belowEditor" }
		);
	}

	function renderRecordingFrame() {
		if (!deps.hasUI()) return;

		// Minimal recording indicator below editor
		deps.setWidget(
			"voice-recording",
			(_tui, theme) => {
				return {
					invalidate() {},
					render(width: number): string[] {
						// v7.2 world-class — Floating Island + Liquid Braille +
						// Aurora gradient + breathing title + activity chip
						// + 300 ms fade-in transition from warmup.
						const { island, titleBreathe, activityTag } = require("./ui-aura") as typeof import("./ui-aura");
						const now = deps.now();
						const elapsed = (now - deps.getRecordingStart()) / 1000;
						const mins = Math.floor(elapsed / 60);
						const secs = elapsed % 60;
						const timeStr = mins > 0 ? `${mins}:${String(Math.floor(secs)).padStart(2, "0")}` : `${secs.toFixed(1)}s`;
						const dim = (s: string) => theme.fg("dim", s);
						const muted = (s: string) => theme.fg("muted", s);
						const accent = (s: string) => theme.fg("accent", s);

						// Activity chip — one-glance "is sound coming in?"
						const chip = activityTag(audioLevel ?? deps.getAudioLevel?.() ?? 0, dim);
						const chipPlain = chip.replace(/\x1b\[[\d;]*[A-Za-z]/g, "");

						// Compact 36-48 cols. Reserved cells:
						//   " ● "(3) + wave + " · TIME "(timer+4) + "  CHIP "(chip+3) + " "(1)
						const islandW = Math.max(36, Math.min(48, width - 2));
						const innerW = islandW - 2;
						const fixedW = 3 + (4 + timeStr.length) + (3 + chipPlain.length) + 1;
						const waveCells = Math.max(8, innerW - fixedW);

						// Fade-in over first 300 ms — wave amplitude
						// scales 0→1 so the recording widget grows out
						// of warmup rather than snapping in.
						const sinceStart = Math.max(0, now - deps.getRecordingStart());
						const fade = Math.min(1, sinceStart / 300);

						const dot = theme.fg("error", getRecordDot());
						const wave = buildAuroraWave((audioLevel ?? deps.getAudioLevel?.() ?? 0) * fade, waveCells);

						// Breathing title — slow aurora-color cycle.
						const titleStyled = titleBreathe(now) + "\x1b[1mVoice Input\x1b[0m";

						const content = ` ${dot} ${wave} ${dim("·")} ${muted(timeStr)}  ${chip} `;
						const footerStyled = `${dim("release")} ${accent("↑")}`;
						return island({ width: islandW, title: titleStyled, content, footer: footerStyled, dim });
					},
				};
			},
			{ placement: "belowEditor" }
		);
	}

	return {
		mountWarmupIndicator,
		mountRecordingIndicator,
		unmountWarmupIndicator: unmountIndicator,
		unmountRecordingIndicator: unmountIndicator,
		renderWarmupFrame,
		renderRecordingFrame,
		stopWarmupAnimation,
		stopRecordingAnimation,
		hideIndicator() {
			if (!deps.hasUI()) return;
			if (indicator) indicator.dispose();
			else clearSlot("voice-recording");
		},
		mountPanel(getText) {
			if (!deps.hasUI()) return;
			const owner = new OwnedWidget("voice-preview", () => {
				if (panel === owner) panel = undefined;
			});
			handingOver = true;
			try {
				deps.registry().register(owner);
			} finally {
				handingOver = false;
			}
			panel = owner;
			deps.setWidget(
				"voice-preview",
				(tui) => {
					const component = createPreviewPanel(getText);
					tui.requestRender();
					return component;
				},
				{ placement: "aboveEditor" }
			);
		},
		unmountPanel() {
			panel?.dispose();
		},
		setState: deps.setState,
		notify: deps.notify,
		playSound: deps.playSound,
		setAudioLevel(level) {
			audioLevel = level;
		},
		setProgress(elapsedMs, holdThresholdMs) {
			progress = Math.min(elapsedMs / holdThresholdMs, 1);
		},
		dispose() {
			stopWarmupAnimation();
			stopRecordingAnimation();
			indicator?.dispose();
			panel?.dispose();
		},
	};
}
