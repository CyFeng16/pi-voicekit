/**
 * Deterministic cleanup of a finished transcript — filler particles now, identifier numerals next.
 *
 * The step is pure: no model, no network, no configuration lookup and no Pi types, so it can run on
 * every completed dictation without a gate and is testable without a session. It is total — every
 * branch returns a string — and it never empties a transcript: a dictation that was nothing but
 * fillers comes back exactly as it was dictated (invariant 2, because an empty editor is worse than
 * a noisy one).
 *
 * Spec: docs/superpowers/specs/2026-10-18-transcript-cleanup-design.md §4.1–§4.2.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** The two switches, already resolved by the caller (spec §4.4) — this module reads no config. */
export interface CleanupOptions {
	fillers: boolean;
	numerals: boolean;
}

/**
 * `off` when both switches are off, `nothing-to-do` when the text is handed back as it stood,
 * `applied` when at least one character was rewritten.
 */
export type CleanupStatus = "off" | "nothing-to-do" | "applied";

export interface CleanupResult {
	/** What to write: the cleaned transcript, or the input verbatim when nothing was rewritten. */
	text: string;
	status: CleanupStatus;
	/** Particles deleted. Always `0` when the input is handed back, since it still carries them. */
	fillersRemoved: number;
	/** Numeral runs converted; the numeral rule of spec §4.3 is not implemented yet, so always `0`. */
	numeralsConverted: number;
}

// ─── What the rules know about a character ───────────────────────────────────

/** The removable vocabulary in full: the two interjections of spec §4.2, and nothing else. */
const FILLERS = new Set([..."呃嗯"]);

/** Marks that become a stranded opener when a removal exposes them at the very start of the text. */
const LEADING_MARKS = new Set([..."，。、；："]);

/** Only the ASCII space is joined or squeezed; a tab or an ideographic space is never touched. */
const SPACE = " ";

/**
 * What a character is to the filler rule. The whole text is classified before anything is rewritten,
 * so the space rule reads a position's neighbours as they were dictated: `a  b` keeps both of its
 * spaces, while the pair that a removal joined is closed up.
 */
type CharClass = "filler" | "space" | "other";

function classify(ch: string): CharClass {
	if (FILLERS.has(ch)) return "filler";
	return ch === SPACE ? "space" : "other";
}

// ─── Filler particles ────────────────────────────────────────────────────────

interface FillerPass {
	text: string;
	removed: number;
}

/**
 * Delete every filler and repair only what the deletion exposed.
 *
 * Three things move and nothing else: the particles themselves, the second space of two runs that a
 * removal joined (`我希望 嗯 先看一下` → `我希望 先看一下`), and — at the very start of the text —
 * the whitespace and the one mark a removal left stranded there (`嗯，对` → `对`). Interior marks are
 * never touched, and whitespace that was already doubled away from a removal is left as it was.
 */
function removeFillerParticles(text: string): FillerPass {
	const chars = Array.from(text);
	const classes = chars.map(classify);
	const kept: string[] = [];
	let removed = 0;
	/** The previous character was a filler, so the next space may be half of a joined pair. */
	let afterRemoval = false;
	/** One stranded opener has been taken; a second mark is text, not damage. */
	let markDropped = false;

	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i]!;
		const cls = classes[i]!;

		if (cls === "filler") {
			removed++;
			afterRemoval = true;
			continue;
		}

		if (removed > 0 && kept.length === 0) {
			// Nothing has been emitted and a removal is what exposed this position, so the start of
			// the text is repair territory: the whitespace it opened up, and a mark it stranded.
			if (cls === "space") continue;
			if (!markDropped && LEADING_MARKS.has(ch)) {
				markDropped = true;
				continue;
			}
		}

		// A removal between two spaces leaves the pair adjacent; one space is enough.
		if (afterRemoval && cls === "space" && kept[kept.length - 1] === SPACE) continue;

		kept.push(ch);
		afterRemoval = false;
	}

	return { text: kept.join(""), removed };
}

// ─── The step ────────────────────────────────────────────────────────────────

function unchanged(text: string, status: CleanupStatus): CleanupResult {
	return { text, status, fillersRemoved: 0, numeralsConverted: 0 };
}

/**
 * Clean `text` according to the two switches and report what happened.
 *
 * Every branch returns a string — throwing is not part of this module's contract; the fail-open
 * guard of invariant 1 is the caller's `try/catch` around the whole completion path. Whenever
 * nothing is rewritten — both switches off, no particle present, or a rewrite that would have
 * emptied the transcript — the input is returned verbatim.
 */
export function cleanTranscript(text: string, options: CleanupOptions): CleanupResult {
	if (!options.fillers && !options.numerals) return unchanged(text, "off");
	// `numerals` is accepted and ignored until the identifier-numeral rule lands: the signature is
	// already the one that rule will use, so no caller changes when it arrives.
	if (!options.fillers) return unchanged(text, "nothing-to-do");

	const cleaned = removeFillerParticles(text);
	// Invariant 2 — cleanup may not delete a dictation.
	if (cleaned.text.trim().length === 0) return unchanged(text, "nothing-to-do");
	if (cleaned.text === text) return unchanged(text, "nothing-to-do");

	return { text: cleaned.text, status: "applied", fillersRemoved: cleaned.removed, numeralsConverted: 0 };
}
