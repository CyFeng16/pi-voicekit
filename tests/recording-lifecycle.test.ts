import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createRecordingController } from "../extensions/voice/recording-controller";
import { startRecordingEntry } from "../extensions/voice/recording-entry";
import { createPreviewRetirement } from "../extensions/voice/preview-retirement.ts";
import { createRecordingOwner } from "../extensions/voice/preview-entrypoint";
import { createPreviewClient } from "../extensions/voice/preview-worker-client";
import { createPreviewSession } from "../extensions/voice/preview-session";
import { abortLocalSession, startLocalSession, stopLocalSession } from "../extensions/voice/local";
import { DEFAULT_CONFIG } from "../extensions/voice/config";
import { decideRecordingStartTimer } from "../extensions/voice/hold-to-talk";
import { classifyOutcome, deliverOutcome } from "../extensions/voice/dictation-outcome";
import { insertTranscript } from "../extensions/voice/editor-sink";

// Task 8 must replace these remaining lifecycle slices with imported lifecycle functions.
// Only external capture, final transcription, timers and UI are faked; ordering runs production code.
const source = readFileSync(new URL("../extensions/voice.ts", import.meta.url), "utf8");
const slice = (from: string, to: string) => {
	const start = source.indexOf(from);
	const end = source.indexOf(to, start);
	if (start < 0 || end <= start) throw new Error(`Missing lifecycle slice: ${from}`);
	return source.slice(start, end);
};
function harness() {
	const controller = createRecordingController({ debug() {} });
	const writes: string[] = [],
		history: string[] = [],
		notices: string[] = [],
		events: string[] = [];
	let finish!: (value: { text: string; hadSpeech: boolean }) => void;
	let entered!: () => void;
	const finalEntered = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const final = new Promise<{ text: string; hadSpeech: boolean }>((resolve) => {
		finish = resolve;
	});
	let passes = 0;
	let releaseGuard!: () => void;
	const run = new Function(
		"ports",
		new Bun.Transpiler({ loader: "ts" }).transformSync(`
		const { recordingController, startRecordingEntry, createRecordingOwner, createPreviewClient,
		 createPreviewSession, startLocalSession, stopLocalSession, abortLocalSession, decideRecordingStartTimer,
		 classifyOutcome, deliverOutcome, insertTranscript, config, spawn, setTimeout, writes, history, notices, events } = ports;
		const ctx = { hasUI: true, ui: { notify: text => notices.push(text), getEditorText: () => "",
		 pasteToEditor: text => writes.push(text), setEditorText: () => { throw new Error("replacement"); } } };
		const cmdCtx = ctx, sub = "dictate", toggleShortcutLabel = "toggle";
		let dictationMode = false, _startingRecording = false;
		let activePreview = null, recordingOwner = null, activeSession = null, statusTimer = null;
		let previewClient = null, previewClientModelDir = null;
		const previewRetirement = ports.previewRetirement;
		const { retirePreviewClient, finishPreview } = previewRetirement;
		let recordingStart = 0, lastStopTime = 0, lastEscapeTime = 0;
		const CORRUPTION_GUARD_MS = 50, SAMPLE_RATE = 16000, CHANNELS = 1;
		const kittyReleaseDetected = false, spaceDownTime = null;
		const voiceDebug = () => {}, safeErrorText = String;
		const setVoiceState = state => recordingController.setState(state);
		const clearRecordingAnimTimer = () => {}, clearWarmupWidget = () => {}, hideWidget = () => {};
		const resetHoldState = () => {}, cancelDelayedStop = () => {}, abortActiveSpeak = () => {};
		const playSound = () => {}, showRecordingWidget = () => {}, updateAudioLevel = () => {}, updateVoiceStatus = () => {};
		const resolvePreviewModelDir = () => null;
		const detectAudioCaptureTool = () => ({ cmd: "fake", args: [], name: "fake" });
		const finalModels = () => [], punctuateTranscript = text => text, addToHistory = text => history.push(text);
		${slice("function abortSession(", "// ─── Extension")}
		${slice("\tasync function startVoiceRecording():", "\tasync function startRecording():")}
		${slice("\tasync function startRecording():", "\n\t// ── Tail recording:")}
		${slice("\tasync function stopVoiceRecording()", "\n\t// ─── Hold-to-Talk State Machine")}
		return {
		 start: startVoiceRecording, stop: stopVoiceRecording,
		 dictate: async () => { ${slice('\t\t\tif (sub === "dictate")', "\t\t\t// /voice history")} },
		 cancel() { ${slice('\t\t\t\t\tvoiceDebug("Escape pressed → canceling voice")', "\n\t\t\t\t\treturn { consume: true };")} },
		 get owner() { return recordingOwner; }, get session() { return activeSession; },
		 get dictationMode() { return dictationMode; },
		 dispose() { clearInterval(statusTimer); activePreview?.abort(); abortSession(activeSession); void previewClient?.destroy(); }
		};
	`)
	);
	const api = run({
		previewRetirement: createPreviewRetirement({ debug() {}, safeErrorText: String, setTimeout, clearTimeout }),
		recordingController: controller,
		startRecordingEntry,
		createRecordingOwner,
		createPreviewClient,
		createPreviewSession,
		startLocalSession,
		abortLocalSession,
		decideRecordingStartTimer,
		classifyOutcome,
		deliverOutcome,
		insertTranscript,
		config: { ...DEFAULT_CONFIG, enabled: true, previewEnabled: false, localModel: "test" },
		writes,
		history,
		notices,
		events,
		setTimeout(callback: () => void, delay: number) {
			expect(delay).toBe(50);
			releaseGuard = callback;
		},
		spawn() {
			events.push("capture");
			return Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
		},
		stopLocalSession(session: Parameters<typeof stopLocalSession>[0], config: typeof DEFAULT_CONFIG) {
			return stopLocalSession(session, config, async () => {
				passes++;
				entered();
				return final;
			});
		},
	});
	return {
		api,
		controller,
		writes,
		history,
		notices,
		events,
		finalEntered,
		feed: () => api.session.recProcess.stdout.emit("data", Buffer.from([1, 0])),
		releaseGuard: () => releaseGuard(),
		finish: () => finish({ text: "final", hadSpeech: true }),
		get passes() {
			return passes;
		},
	};
}

test("start moves idle → recording and reports true", async () => {
	const h = harness();
	try {
		expect(h.controller.state).toBe("idle");
		expect(await h.api.start()).toBe(true);
		expect(h.controller.state).toBe("recording");
		expect(h.controller.generation).toBe(1);
	} finally {
		h.api.dispose();
	}
});

test("stop during finalizing does not start a second final pass", async () => {
	const h = harness();
	try {
		await h.api.start();
		h.feed();
		const stopping = h.api.stop();
		await h.finalEntered;
		expect(h.controller.state).toBe("finalizing");
		await h.api.stop();
		expect(h.passes).toBe(1);
		expect(h.notices).toEqual(["Transcribing with test…"]);
		h.finish();
		await stopping;
		expect(h.writes).toEqual(["final"]);
		expect(h.history).toEqual(["final"]);
	} finally {
		h.api.dispose();
	}
});

test("a second start while finalizing cancels the first", async () => {
	const h = harness();
	try {
		await h.api.start();
		h.feed();
		const owner = h.api.owner,
			first = h.controller.generation;
		const stopping = h.api.stop();
		await h.finalEntered;
		const starting = h.api.start();
		expect(owner.deliver()).toBe(false);
		expect(h.controller.owns(first)).toBe(false);
		expect(h.events).toEqual(["capture"]);
		h.releaseGuard();
		expect(await starting).toBe(true);
		expect(h.controller.generation).toBe(3);
		h.finish();
		await stopping;
		expect(h.writes).toEqual([]);
		expect(h.history).toEqual([]);
		expect(h.controller.state).toBe("recording");
	} finally {
		h.api.dispose();
	}
});

test("a superseded start leaves dictationMode false", async () => {
	const h = harness();
	try {
		await h.api.start();
		const starting = h.api.dictate();
		h.api.cancel();
		h.releaseGuard();
		await starting;
		expect(h.api.dictationMode).toBe(false);
		expect(h.notices).toEqual([]);
		expect(h.events).toEqual(["capture"]);
	} finally {
		h.api.dispose();
	}
});

for (const phase of ["capture", "finalizing"] as const) {
	test(`cancel leaves no editor write and no history call (${phase})`, async () => {
		const h = harness();
		try {
			await h.api.start();
			h.feed();
			const stopping = phase === "finalizing" ? h.api.stop() : Promise.resolve();
			if (phase === "finalizing") await h.finalEntered;
			h.api.cancel();
			h.finish();
			await stopping;
			expect(h.controller.state).toBe("idle");
			expect(h.writes).toEqual([]);
			expect(h.history).toEqual([]);
		} finally {
			h.api.dispose();
		}
	});
}
