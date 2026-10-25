/**
 * What a finished recording means, and the one delivery it gets.
 *
 * A recording ends in exactly one of three ways, and only one of them is the good one:
 *
 * - `final`: the offline pass produced authoritative text. It runs the existing chain —
 *   cleanup → punctuation → history → editor — because that chain is the reason the final pass is
 *   authoritative at all.
 * - `unconfirmed`: the offline pass failed, timed out, or its worker died, but the preview already
 *   showed words. Those words are the user's only copy: they are inserted **verbatim**, with no
 *   cleanup, no punctuation and no history entry. A fallback that went through the same chain would
 *   become indistinguishable from a good transcript afterwards, and re-writing words the user has
 *   already read is worse than leaving them rough (spec §5.4 item 2).
 * - `empty`: there is nothing to insert. The notice states the recorded reason, and a decode failure
 *   is never described as silence — a failed decode is not evidence about the microphone (spec §5.5).
 *
 * The other contract here is the UI gate. History in this extension has always been written inside
 * the same `if (ctx?.hasUI)` block as the editor write, and spec §5.4 item 4 keeps that rule: without
 * a UI nothing is inserted and nothing enters history, and the outcome still produces its notice. The
 * editor sink deliberately has no history dependency, so this module is the only place that can own
 * that gate.
 *
 * Exactly one notice is emitted per completed recording, for every outcome including `empty`. A
 * degraded preview is folded into that notice rather than reported separately (spec §5.5, §5.6,
 * unqualified); the raw reason token stays in the debug channel, because it is not something a user
 * can act on.
 *
 * The notice also has to survive the editor. `insertTranscript` reports how the write went, and its
 * `fallback` mode means text may be partly or wholly missing: those runs get a notice that says the
 * write failed and points at the debug channel, never "Transcript inserted" (spec §5.5: never claim
 * success that did not happen).
 *
 * Classification is a pure function. Delivery is the ordered side effects for its result, and it
 * writes history before the editor so a throwing editor verb cannot cost the recording its history
 * entry — the same outcome the old inline `try`/`catch` around the editor write produced.
 */

import type { SinkResult } from "./editor-sink";

export type DictationOutcome =
	| { kind: "final"; text: string }
	| { kind: "unconfirmed"; text: string }
	| { kind: "empty"; reason: "no-audio" | "no-speech" | "decode-failed" };

/** The evidence a finished recording leaves behind. */
export interface OutcomeInput {
	/** Bytes the capture side buffered for the recording. Zero is direct evidence about the microphone. */
	capturedBytes: number;
	/** `null` means the final pass failed, timed out, or its worker died. */
	finalText: string | null;
	/** Whether the final pass's own decode found speech. Meaningless when `finalText` is `null`. */
	finalHadSpeech: boolean;
	/** The preview transcript as the composer held it at delivery time. */
	previewText: string;
}

type EmptyReason = Extract<DictationOutcome, { kind: "empty" }>["reason"];

type NoticeLevel = "info" | "warning" | "error";

/**
 * Decides what the recording meant. Precedence is evidence-first:
 *
 * 1. no captured bytes → `empty`/`no-audio`, whatever the other fields claim;
 * 2. no final text at all (`null`) → `unconfirmed` when the preview held words, otherwise
 *    `empty`/`decode-failed`;
 * 3. a final pass that recognised no speech → `empty`/`no-speech`, even when its text is blank;
 * 4. a final text that is only whitespace although speech was detected → the same fallback as 2;
 * 5. otherwise `final`.
 *
 * Whitespace is not words: a preview that only ever held spaces has nothing to deliver, so it falls
 * through to the decode failure instead of producing an empty fallback. The same holds for the final
 * pass: a decode that reports speech yet returns only spaces produces no transcript, so it takes the
 * fallback path too rather than becoming a `final` that inserts and records an empty string.
 * `no-speech` still outranks it, because a decode that found no speech at all is the truer account.
 */
export function classifyOutcome(input: OutcomeInput): DictationOutcome {
	if (input.capturedBytes === 0) return { kind: "empty", reason: "no-audio" };
	if (input.finalText === null) return withoutFinalText(input);
	if (!input.finalHadSpeech) return { kind: "empty", reason: "no-speech" };
	if (input.finalText.trim() === "") return withoutFinalText(input);
	return { kind: "final", text: input.finalText };
}

/** No usable final text: hand back the preview when it holds words, otherwise report the decode. */
function withoutFinalText(input: OutcomeInput): DictationOutcome {
	return input.previewText.trim() !== ""
		? { kind: "unconfirmed", text: input.previewText }
		: { kind: "empty", reason: "decode-failed" };
}

/** The side effects a delivery is allowed to perform, all bound to the live recording context. */
export interface DeliveryDeps {
	/** `false` → no insert and no history. The notice is still emitted; the host makes it a no-op. */
	hasUI: boolean;
	clean(text: string): string;
	punctuate(text: string): string;
	addToHistory(text: string): void;
	/**
	 * `editor-sink.insertTranscript` bound to the live context. Its result decides the notice: only
	 * `paste` and `remainder` mean every character reached the buffer.
	 */
	insert(text: string): SinkResult;
	notify(message: string, level: NoticeLevel): void;
}

/** A notice and the level it is shown at. */
interface Notice {
	message: string;
	level: NoticeLevel;
}

/**
 * The notice for every `empty` reason. Two of these are the copy the pre-preview path used. The
 * terminating period is added by the delivery, so the degradation suffix can be folded in.
 */
const EMPTY_NOTICES: Record<EmptyReason, Notice> = {
	"no-audio": {
		message: "Microphone captured no audio — check mic permissions",
		level: "error",
	},
	"no-speech": {
		message: "Microphone captured silence — no speech detected",
		level: "warning",
	},
	"decode-failed": {
		// Never mentions the microphone: capture worked, the decode did not.
		message: "The final transcription failed and produced no transcript; nothing was inserted",
		level: "error",
	},
};

/**
 * How a degradation reads to a user. The reason token (`preview-worker-failed`, …) is an internal
 * identifier; a future reason falls back to the generic wording instead of leaking it into a notice.
 */
function previewState(reason: string): string {
	switch (reason) {
		case "preview-worker-failed":
			return "live preview unavailable";
		case "preview-decode-failed":
			return "live preview stalled";
		default:
			return "live preview degraded";
	}
}

/** The trailing parenthetical that folds a degraded preview into the outcome notice. */
function degradedSuffix(degraded: string | null): string {
	return degraded === null ? "" : ` (${previewState(degraded)})`;
}

/**
 * How much of a transcript reached the editor, read from what the sink reported. `paste` and
 * `remainder` both mean every character is in the buffer; `fallback` means text may be partly or
 * wholly missing; `no-ui` means nothing was written, which is only reachable when the bound host
 * disagrees with `deps.hasUI`.
 */
type Reach = "complete" | "partial" | "none";

function reachOf(sink: SinkResult | null): Reach {
	if (sink === null || sink.mode === "no-ui") return "none";
	return sink.mode === "fallback" ? "partial" : "complete";
}

/**
 * The single notice for a delivered transcript, chosen from what the editor actually reported.
 *
 * `partial` is the sink's `fallback` mode: some or all of the text is missing, so the notice says the
 * write failed and points at the debug channel instead of claiming an insert. That is a warning for
 * `final` — the full text is in the history — and an error for `unconfirmed`, whose only copy is the
 * one the editor may have lost. A missing UI never says the text was inserted either.
 */
function deliveredNotice(unconfirmed: boolean, reach: Reach, degraded: string | null): Notice {
	let notice: Notice;
	if (unconfirmed) {
		if (reach === "complete") {
			notice = {
				message: "The final transcription failed; the preview text was inserted unchanged",
				level: "warning",
			};
		} else if (reach === "partial") {
			notice = {
				message:
					"The final transcription failed and the preview text could not be fully written to the editor;" +
					" the details are in the debug log",
				level: "error",
			};
		} else {
			notice = {
				message: "The final transcription failed; no editor is available to receive the preview text",
				level: "warning",
			};
		}
	} else if (reach === "complete") {
		notice = { message: "Transcript inserted", level: "info" };
	} else if (reach === "partial") {
		notice = {
			message:
				"The transcript could not be fully written to the editor; the full text is in the history" +
				" and the details are in the debug log",
			level: "warning",
		};
	} else {
		notice = { message: "Transcript ready, but no editor is available to receive it", level: "warning" };
	}
	return { message: `${notice.message}${degradedSuffix(degraded)}.`, level: notice.level };
}

/**
 * Performs the one delivery for a classified outcome and emits its single notice.
 *
 * `final` and `unconfirmed` are the only outcomes that write anything, and both are gated on
 * `deps.hasUI`. `degraded` describes the preview channel, not the outcome: it is folded into the one
 * notice whatever the outcome was, `empty` included.
 */
export function deliverOutcome(outcome: DictationOutcome, degraded: string | null, deps: DeliveryDeps): void {
	if (outcome.kind === "empty") {
		const notice = EMPTY_NOTICES[outcome.reason];
		deps.notify(`${notice.message}${degradedSuffix(degraded)}.`, notice.level);
		return;
	}

	if (outcome.kind === "unconfirmed") {
		// Verbatim, and never history: the preview is the fallback the user already saw, not a result
		// the extension produced. Skipping cleanup and punctuation is what keeps it from looking like one.
		const sink = deps.hasUI ? deps.insert(outcome.text) : null;
		const notice = deliveredNotice(true, reachOf(sink), degraded);
		deps.notify(notice.message, notice.level);
		return;
	}

	const text = deps.punctuate(deps.clean(outcome.text));
	let sink: SinkResult | null = null;
	if (deps.hasUI) {
		// History first: an editor verb that throws must not cost the recording its history entry.
		deps.addToHistory(text);
		sink = deps.insert(text);
	}
	const notice = deliveredNotice(false, reachOf(sink), degraded);
	deps.notify(notice.message, notice.level);
}
