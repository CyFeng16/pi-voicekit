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
 * Exactly one notice is emitted per completed recording. A degraded preview is folded into that
 * notice rather than reported separately (spec §5.5, §5.6); the raw reason token stays in the debug
 * channel, because it is not something a user can act on. An `empty` outcome carries only the reason
 * that produced it — "the preview degraded too" would bury the evidence that actually matters.
 *
 * Classification is a pure function. Delivery is the ordered side effects for its result, and it
 * writes history before the editor so a throwing editor verb cannot cost the recording its history
 * entry — the same outcome the old inline `try`/`catch` around the editor write produced.
 */

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
 * 2. no final text → `unconfirmed` when the preview held words, otherwise `empty`/`decode-failed`;
 * 3. a final text that recognised no speech → `empty`/`no-speech`;
 * 4. otherwise `final`.
 *
 * Whitespace is not words: a preview that only ever held spaces has nothing to deliver, so it falls
 * through to the decode failure instead of producing an empty fallback.
 */
export function classifyOutcome(input: OutcomeInput): DictationOutcome {
	if (input.capturedBytes === 0) return { kind: "empty", reason: "no-audio" };
	if (input.finalText === null) {
		return input.previewText.trim() !== ""
			? { kind: "unconfirmed", text: input.previewText }
			: { kind: "empty", reason: "decode-failed" };
	}
	if (!input.finalHadSpeech) return { kind: "empty", reason: "no-speech" };
	return { kind: "final", text: input.finalText };
}

/** The side effects a delivery is allowed to perform, all bound to the live recording context. */
export interface DeliveryDeps {
	/** `false` → no insert and no history. The notice is still emitted; the host makes it a no-op. */
	hasUI: boolean;
	clean(text: string): string;
	punctuate(text: string): string;
	addToHistory(text: string): void;
	/** `editor-sink.insertTranscript` bound to the live context; its result mode is not part of this seam. */
	insert(text: string): void;
	notify(message: string, level: NoticeLevel): void;
}

/** The notice for every `empty` reason. Two of these are the copy the pre-preview path used. */
const EMPTY_NOTICES: Record<EmptyReason, { message: string; level: NoticeLevel }> = {
	"no-audio": {
		message: "Microphone captured no audio — check mic permissions.",
		level: "error",
	},
	"no-speech": {
		message: "Microphone captured silence — no speech detected.",
		level: "warning",
	},
	"decode-failed": {
		// Never mentions the microphone: capture worked, the decode did not.
		message: "The final transcription failed and produced no transcript; nothing was inserted.",
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
 * The single notice for a delivered transcript. Without a UI it must not say the text was inserted —
 * "never claim success that did not happen" applies to the notice as much as to the editor.
 */
function deliveredNotice(hasUI: boolean, degraded: string | null, unconfirmed: boolean): string {
	let delivered: string;
	if (unconfirmed) {
		delivered = hasUI
			? "The final transcription failed; the preview text was inserted unchanged"
			: "The final transcription failed; no editor is available to receive the preview text";
	} else {
		delivered = hasUI ? "Transcript inserted" : "Transcript ready, but no editor is available to receive it";
	}
	return `${delivered}${degradedSuffix(degraded)}.`;
}

/**
 * Performs the one delivery for a classified outcome and emits its single notice.
 *
 * `final` and `unconfirmed` are the only outcomes that write anything, and both are gated on
 * `deps.hasUI`. `degraded` describes the preview channel, not the outcome: it is folded into the
 * notice of an outcome that delivered text, and ignored for an `empty` outcome.
 */
export function deliverOutcome(outcome: DictationOutcome, degraded: string | null, deps: DeliveryDeps): void {
	if (outcome.kind === "empty") {
		const notice = EMPTY_NOTICES[outcome.reason];
		deps.notify(notice.message, notice.level);
		return;
	}

	if (outcome.kind === "unconfirmed") {
		// Verbatim, and never history: the preview is the fallback the user already saw, not a result
		// the extension produced. Skipping cleanup and punctuation is what keeps it from looking like one.
		if (deps.hasUI) deps.insert(outcome.text);
		deps.notify(deliveredNotice(deps.hasUI, degraded, true), "warning");
		return;
	}

	const text = deps.punctuate(deps.clean(outcome.text));
	if (deps.hasUI) {
		// History first: an editor verb that throws must not cost the recording its history entry.
		deps.addToHistory(text);
		deps.insert(text);
	}
	deps.notify(deliveredNotice(deps.hasUI, degraded, false), deps.hasUI ? "info" : "warning");
}
