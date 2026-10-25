import { startRecordingEntry } from "../extensions/voice/recording-entry";
import { createRecordingController } from "../extensions/voice/recording-controller";
import { expect, test } from "bun:test";
import { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRecordingPresenter } from "../extensions/voice/recording-presenter";
import { makeWidgetRegistry } from "../extensions/voice/ui-widget-base";
import { createPreviewClient } from "../extensions/voice/preview-worker-client";
import { createPreviewSession } from "../extensions/voice/preview-session";
import { createRecordingOwner } from "../extensions/voice/preview-entrypoint";
import { startLocalSession } from "../extensions/voice/local";
import { decideRecordingStartTimer } from "../extensions/voice/hold-to-talk";

// Temporary migration test: execute the real entrypoint sequencing, not a second model of it.
// Task 9 must move these assertions to the consumed controller before removing this slice too.
const source = readFileSync(new URL("../extensions/voice.ts", import.meta.url), "utf8");
const startBody = source.slice(
	source.indexOf("\tasync function startRecording():"),
	source.indexOf("\n\t// ── Tail recording:")
);
const mountBody = source.slice(
	source.indexOf("\tfunction showRecordingWidget()"),
	source.indexOf("\n\tfunction showRecordingWidgetFrame()")
);

for (const captureAvailable of [false, true]) {
	test(`entrypoint ${captureAvailable ? "mounts only after capture succeeds" : "does not mount when capture is unavailable"}`, async () => {
		const events: string[] = [];
		const notices: string[] = [];
		const registry = makeWidgetRegistry();
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
			setState: (state) => events.push(`state:${state}`),
			notify: (message) => notices.push(message),
			playSound: (sound) => events.push(`sound:${sound}`),
			debug() {},
		});
		const run = new Function(
			"ports",
			new Bun.Transpiler({ loader: "ts" }).transformSync(`
			const { recordingPresenter, createRecordingOwner, createPreviewClient, createPreviewSession,
				startLocalSession, decideRecordingStartTimer, detectAudioCaptureTool, spawn, startRecordingEntry, createRecordingController } = ports;
			const recordingController = createRecordingController({ debug() {} });
			const retirePreviewClient = () => {};
			const config = { previewEnabled: false }, recordingStart = 0;
			let activePreview = null, recordingOwner = null;
			let previewClient = null, previewClientModelDir = null, previewFinish = null;
			let activeSession = null, statusTimer = null;
			const ctx = { hasUI: true, ui: { notify: recordingPresenter.notify } };
			const voiceDebug = () => {}, resolvePreviewModelDir = () => null;
			const setVoiceState = state => { recordingController.setState(state); recordingPresenter.setState(state); };
			const clearRecordingAnimTimer = recordingPresenter.stopRecordingAnimation;
			const clearWarmupWidget = recordingPresenter.stopWarmupAnimation;
			const hideWidget = recordingPresenter.hideIndicator, playSound = recordingPresenter.playSound;
			const resetHoldState = () => {}, kittyReleaseDetected = false, spaceDownTime = null;
			${mountBody}
			${startBody}
			return startRecording().finally(() => { clearInterval(statusTimer); activePreview?.abort(); });
		`)
		);
		try {
			const started = await run({
				recordingPresenter: presenter,
				startRecordingEntry,
				createRecordingController,
				createRecordingOwner,
				createPreviewClient,
				createPreviewSession,
				startLocalSession,
				decideRecordingStartTimer,
				detectAudioCaptureTool() {
					events.push("capture-detect");
					return captureAvailable ? { cmd: "unused", args: [], name: "sox" } : null;
				},
				spawn() {
					events.push("capture-start");
					// Bun lazily reads native spawn handles from stdio getters. This process is
					// intentionally never spawned, so give it explicit absent streams.
					return Object.defineProperties(new ChildProcess(), {
						stdout: { value: null },
						stderr: { value: null },
					});
				},
			});
			expect(started).toBe(captureAvailable);
			expect(events).toEqual(
				captureAvailable
					? ["state:recording", "capture-detect", "capture-start", "mount", "sound:start"]
					: ["state:recording", "capture-detect", "sound:error", "state:idle", "state:idle"]
			);
			expect(notices).toEqual(
				captureAvailable
					? []
					: ["Voice error: No audio capture tool found. Install one of: sox, ffmpeg, or arecord (Linux)"]
			);
		} finally {
			presenter.dispose();
		}
	});
}
