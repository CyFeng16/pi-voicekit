import { describe, expect, mock, test } from "bun:test";
import {
	classifyOutcome,
	deliverOutcome,
	type DeliveryDeps,
	type DictationOutcome,
} from "../extensions/voice/dictation-outcome";

/**
 * A finished recording has exactly one meaning and exactly one delivery.
 *
 * These tests pin the two halves of that contract separately: `classifyOutcome` decides from the
 * evidence only (capture, the final pass, the preview), and `deliverOutcome` performs the ordered
 * side effects for that decision — or performs none of the text-side ones and still says what
 * happened. The properties under test are the ones a user can tell apart: an unconfirmed fallback
 * must not be laundered into a good transcript (no cleanup, no punctuation, no history), a decode
 * failure must never be reported as microphone silence, and a session without a UI must leave both
 * the editor and the history untouched.
 */

interface Deps {
	deps: DeliveryDeps;
	clean: ReturnType<typeof mock>;
	punctuate: ReturnType<typeof mock>;
	addToHistory: ReturnType<typeof mock>;
	insert: ReturnType<typeof mock>;
	notify: ReturnType<typeof mock>;
}

/** Delivery verbs as spies; `hasUI` defaults to true, as in an interactive run. */
function createDeps(overrides: Partial<DeliveryDeps> = {}): Deps {
	const clean = mock((text: string) => text);
	const punctuate = mock((text: string) => text);
	const addToHistory = mock((_text: string) => {});
	const insert = mock((_text: string) => {});
	const notify = mock((_message: string, _level: "info" | "warning" | "error") => {});
	const deps: DeliveryDeps = { hasUI: true, clean, punctuate, addToHistory, insert, notify, ...overrides };
	return { deps, clean, punctuate, addToHistory, insert, notify };
}

/** The single notice a delivery emitted, as `[message, level]`. */
function onlyNotice(notify: ReturnType<typeof mock>): [string, string] {
	expect(notify).toHaveBeenCalledTimes(1);
	const [call] = notify.mock.calls;
	expect(call).toBeDefined();
	return call as [string, string];
}

describe("classifyOutcome — precedence", () => {
	test("no captured audio is no-audio, whatever else the recording produced", () => {
		expect(classifyOutcome({ capturedBytes: 0, finalText: null, finalHadSpeech: false, previewText: "" })).toEqual({
			kind: "empty",
			reason: "no-audio",
		});
		// Capture evidence outranks a final text: there is nothing to attribute it to.
		expect(classifyOutcome({ capturedBytes: 0, finalText: "你好", finalHadSpeech: true, previewText: "你好" })).toEqual(
			{
				kind: "empty",
				reason: "no-audio",
			}
		);
	});

	test("a failed final pass falls back to the preview, verbatim", () => {
		const outcome = classifyOutcome({
			capturedBytes: 9000,
			finalText: null,
			finalHadSpeech: false,
			previewText: "你好",
		});
		expect(outcome).toEqual({ kind: "unconfirmed", text: "你好" });
	});

	test("the fallback keeps the preview exactly as the composer held it", () => {
		const previewText = "  你好，世界  ";
		expect(classifyOutcome({ capturedBytes: 9000, finalText: null, finalHadSpeech: false, previewText })).toEqual({
			kind: "unconfirmed",
			text: previewText,
		});
	});

	test("a failed final pass with no preview text is a decode failure, not silence", () => {
		expect(classifyOutcome({ capturedBytes: 9000, finalText: null, finalHadSpeech: false, previewText: "" })).toEqual({
			kind: "empty",
			reason: "decode-failed",
		});
		// Whitespace is not words: a preview that only ever held spaces has nothing to deliver.
		expect(
			classifyOutcome({ capturedBytes: 9000, finalText: null, finalHadSpeech: false, previewText: " \n\t " })
		).toEqual({ kind: "empty", reason: "decode-failed" });
	});

	test("a successful decode that recognised no speech is no-speech", () => {
		expect(classifyOutcome({ capturedBytes: 9000, finalText: "", finalHadSpeech: false, previewText: "你好" })).toEqual(
			{ kind: "empty", reason: "no-speech" }
		);
	});

	test("a successful decode is final, text and all", () => {
		expect(
			classifyOutcome({ capturedBytes: 9000, finalText: "你好，世界。", finalHadSpeech: true, previewText: "你好" })
		).toEqual({ kind: "final", text: "你好，世界。" });
	});
});

describe("deliverOutcome — side effects", () => {
	test("unconfirmed text skips cleanup, punctuation and history", () => {
		const outcome = classifyOutcome({
			capturedBytes: 9000,
			finalText: null,
			finalHadSpeech: false,
			previewText: "你好",
		});
		expect(outcome).toEqual({ kind: "unconfirmed", text: "你好" });
		const { deps, clean, punctuate, addToHistory, insert, notify } = createDeps();
		deliverOutcome(outcome, "final-worker-failed", deps);
		expect(clean).not.toHaveBeenCalled();
		expect(punctuate).not.toHaveBeenCalled();
		expect(addToHistory).not.toHaveBeenCalled();
		expect(insert).toHaveBeenCalledWith("你好");
		expect(notify).toHaveBeenCalledTimes(1);
	});

	test("a failed decode never claims silence", () => {
		const outcome = classifyOutcome({ capturedBytes: 0, finalText: null, finalHadSpeech: false, previewText: "" });
		expect(outcome).toEqual({ kind: "empty", reason: "no-audio" });

		// The same final-pass failure with audio but no preview text: the editor stays untouched and
		// the notice talks about the transcription, never about the microphone.
		const failed = classifyOutcome({ capturedBytes: 9000, finalText: null, finalHadSpeech: false, previewText: "" });
		expect(failed).toEqual({ kind: "empty", reason: "decode-failed" });
		const { deps, insert, addToHistory, notify } = createDeps();
		deliverOutcome(failed, null, deps);
		expect(insert).not.toHaveBeenCalled();
		expect(addToHistory).not.toHaveBeenCalled();
		const [message] = onlyNotice(notify);
		expect(message).not.toMatch(/silence|microphone|no speech/i);
		expect(message).toMatch(/final transcription failed/i);
	});

	test("without a UI nothing is inserted and nothing enters history", () => {
		const { deps, insert, addToHistory, notify } = createDeps({ hasUI: false });
		deliverOutcome({ kind: "final", text: "你好" }, null, deps);
		expect(insert).not.toHaveBeenCalled();
		expect(addToHistory).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledTimes(1);
	});

	test("the UI gate also covers the unconfirmed fallback", () => {
		const { deps, insert, clean, punctuate, addToHistory, notify } = createDeps({ hasUI: false });
		deliverOutcome({ kind: "unconfirmed", text: "你好" }, null, deps);
		expect(clean).not.toHaveBeenCalled();
		expect(punctuate).not.toHaveBeenCalled();
		expect(addToHistory).not.toHaveBeenCalled();
		expect(insert).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledTimes(1);
	});

	test("final runs cleanup then punctuation then history, in that order", () => {
		const order: string[] = [];
		const deps: DeliveryDeps = {
			hasUI: true,
			clean: (text: string) => {
				order.push("clean");
				return text;
			},
			punctuate: (text: string) => {
				order.push("punctuate");
				return `p:${text}`;
			},
			addToHistory: (text: string) => {
				order.push(`history:${text}`);
			},
			insert: (text: string) => {
				order.push(`insert:${text}`);
			},
			notify: () => {
				order.push("notify");
			},
		};
		deliverOutcome({ kind: "final", text: "你好" }, null, deps);
		expect(order).toEqual(["clean", "punctuate", "history:p:你好", "insert:p:你好", "notify"]);
	});

	test("history and the editor both receive the punctuated text, not the raw one", () => {
		const { deps, addToHistory, insert } = createDeps({
			clean: (text: string) => text.replace(/嗯/g, ""),
			punctuate: (text: string) => `${text}。`,
		});
		deliverOutcome({ kind: "final", text: "嗯你好" }, null, deps);
		expect(addToHistory).toHaveBeenCalledWith("你好。");
		expect(insert).toHaveBeenCalledWith("你好。");
	});

	test("empty outcomes write nothing and never run the text chain", () => {
		const reasons: Array<"no-audio" | "no-speech" | "decode-failed"> = ["no-audio", "no-speech", "decode-failed"];
		for (const reason of reasons) {
			const { deps, clean, punctuate, addToHistory, insert, notify } = createDeps();
			deliverOutcome({ kind: "empty", reason }, null, deps);
			expect(clean).not.toHaveBeenCalled();
			expect(punctuate).not.toHaveBeenCalled();
			expect(addToHistory).not.toHaveBeenCalled();
			expect(insert).not.toHaveBeenCalled();
			onlyNotice(notify);
		}
	});
});

describe("deliverOutcome — the one notice", () => {
	test("every outcome emits exactly one notice, with or without a UI and whatever degraded says", () => {
		const outcomes: DictationOutcome[] = [
			{ kind: "final", text: "你好" },
			{ kind: "unconfirmed", text: "你好" },
			{ kind: "empty", reason: "no-audio" },
			{ kind: "empty", reason: "no-speech" },
			{ kind: "empty", reason: "decode-failed" },
		];
		const degradedReasons = [null, "preview-worker-failed", "preview-decode-failed"];
		for (const outcome of outcomes) {
			for (const degraded of degradedReasons) {
				for (const hasUI of [true, false]) {
					const { deps, notify } = createDeps({ hasUI });
					deliverOutcome(outcome, degraded, deps);
					expect(notify).toHaveBeenCalledTimes(1);
				}
			}
		}
	});

	test("degradation is folded into the outcome notice, worded as preview state", () => {
		const { deps, notify } = createDeps();
		deliverOutcome({ kind: "final", text: "你好" }, "preview-worker-failed", deps);
		const [message] = onlyNotice(notify);
		expect(message).toBe("Transcript inserted (live preview unavailable).");
		// The internal reason token is for the debug channel, not for the user.
		expect(message).not.toContain("preview-worker-failed");
	});

	test("each outcome notice states its reason and stays one sentence", () => {
		const cases: Array<{ outcome: DictationOutcome; degraded: string | null; message: string; level: string }> = [
			{ outcome: { kind: "final", text: "你好" }, degraded: null, message: "Transcript inserted.", level: "info" },
			{
				outcome: { kind: "final", text: "你好" },
				degraded: "preview-decode-failed",
				message: "Transcript inserted (live preview stalled).",
				level: "info",
			},
			{
				outcome: { kind: "unconfirmed", text: "你好" },
				degraded: null,
				message: "The final transcription failed; the preview text was inserted unchanged.",
				level: "warning",
			},
			{
				outcome: { kind: "unconfirmed", text: "你好" },
				degraded: "preview-worker-failed",
				message: "The final transcription failed; the preview text was inserted unchanged (live preview unavailable).",
				level: "warning",
			},
			{
				outcome: { kind: "empty", reason: "no-audio" },
				degraded: null,
				message: "Microphone captured no audio — check mic permissions.",
				level: "error",
			},
			{
				outcome: { kind: "empty", reason: "no-speech" },
				degraded: null,
				message: "Microphone captured silence — no speech detected.",
				level: "warning",
			},
			{
				outcome: { kind: "empty", reason: "decode-failed" },
				degraded: null,
				message: "The final transcription failed and produced no transcript; nothing was inserted.",
				level: "error",
			},
		];
		for (const { outcome, degraded, message, level } of cases) {
			const { deps, notify } = createDeps();
			deliverOutcome(outcome, degraded, deps);
			const [actualMessage, actualLevel] = onlyNotice(notify);
			expect(actualMessage).toBe(message);
			expect(actualLevel).toBe(level);
			// One sentence: a single terminating period and no sentence boundary inside it.
			expect(message.endsWith(".")).toBe(true);
			expect(message.slice(0, -1)).not.toContain(". ");
		}
	});

	test("without a UI the notice does not claim the transcript was inserted", () => {
		for (const outcome of [
			{ kind: "final", text: "你好" },
			{ kind: "unconfirmed", text: "你好" },
		] as DictationOutcome[]) {
			const { deps, notify, insert } = createDeps({ hasUI: false });
			deliverOutcome(outcome, null, deps);
			expect(insert).not.toHaveBeenCalled();
			const [message, level] = onlyNotice(notify);
			expect(message).not.toMatch(/inserted/i);
			expect(message).toMatch(/no editor/i);
			expect(level).toBe("warning");
		}
	});

	test("an unknown degrade reason still folds into the notice without its raw token", () => {
		const { deps, notify } = createDeps();
		deliverOutcome({ kind: "final", text: "你好" }, "some-future-reason", deps);
		const [message] = onlyNotice(notify);
		expect(message).toBe("Transcript inserted (live preview degraded).");
		expect(message).not.toContain("some-future-reason");
	});

	test("an empty outcome notices only its own reason: the preview has no bearing on it", () => {
		// Nothing was produced, so "the preview degraded too" would bury the evidence that matters.
		const { deps, notify } = createDeps();
		deliverOutcome({ kind: "empty", reason: "no-speech" }, "preview-worker-failed", deps);
		const [message] = onlyNotice(notify);
		expect(message).toBe("Microphone captured silence — no speech detected.");
	});
});
