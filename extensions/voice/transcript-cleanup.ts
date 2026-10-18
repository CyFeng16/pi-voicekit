/**
 * Deterministic cleanup of a finished transcript — filler particles and identifier numerals.
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
	/** Numeral runs converted. Always `0` when the input is handed back, since it still carries them. */
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
 * spaces, while the two space runs that a removal joined are squeezed into one.
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
 * Three things move and nothing else: the particles themselves; the two space runs that a removal
 * joined, squeezed into a single space however many spaces each side carried (`我希望 嗯 先看一下`
 * → `我希望 先看一下`, `a  嗯  b` → `a b`); and — at the very start of the text — the whitespace
 * and the one mark a removal left stranded there (`嗯，对` → `对`). Interior marks are never touched,
 * and whitespace that was already doubled away from a removal is left as it was.
 */
function removeFillerParticles(text: string): FillerPass {
	const chars = Array.from(text);
	const classes = chars.map(classify);
	const kept: string[] = [];
	let removed = 0;
	/** The previous character was a filler, so the next space is half of a run the removal joined. */
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

		// A removal joined a space run on each side, so the joined run collapses to one space —
		// whichever side carried more than one, `a  嗯  b` is `a b`. Further spaces on the right
		// belong to the same run and are skipped by the same branch.
		if (afterRemoval && cls === "space" && kept[kept.length - 1] === SPACE) {
			while (kept[kept.length - 1] === SPACE) kept.pop();
			kept.push(SPACE);
			continue;
		}

		kept.push(ch);
		afterRemoval = false;
	}

	return { text: kept.join(""), removed };
}

// ─── Numerals inside identifiers ─────────────────────────────────────────────

/** Every character a numeral run may be built from: the digits, the four units and the point (§4.3). */
const NUMERAL_CHARS = new Set([..."零一二三四五六七八九十百千万点"]);

/** The characters that make a run a value rather than a digit sequence. */
const UNIT_CHARS = new Set([..."十百千万"]);

/** The decimal point inside a run: `四点一` is `4.1`. */
const DECIMAL_POINT = "点";

/** `零`…`九` as the recogniser writes them, in the order of their value. */
const ARABIC_DIGITS: Record<string, string> = {
	零: "0",
	一: "1",
	二: "2",
	三: "3",
	四: "4",
	五: "5",
	六: "6",
	七: "7",
	八: "8",
	九: "9",
};

/** The magnitude of `万`, the only grouping a Chinese value needs at these sizes. */
const WAN = 10_000;

/** The unit characters and their magnitudes. */
const UNIT_VALUES: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: WAN };

/** A token the numeral rule may bind to: Latin letters and digits, nothing else (`h200` is one). */
const LATIN_TOKEN = /^[A-Za-z0-9]+$/;

/** The bound of spec §4.3 — it admits `bf`, `h`, `a`, `v`, `p`, `t` and `k`, never `kubernetes`. */
const LATIN_TOKEN_MAX = 4;

/** The maximal prefix of `piece` built from numeral characters only; `""` when it starts with one that is not. */
function numeralPrefix(piece: string): string {
	let end = 0;
	while (end < piece.length && NUMERAL_CHARS.has(piece[end]!)) end++;
	return piece.slice(0, end);
}

/** `零`…`九` as Arabic digits; the caller has already proven every character of `part` is one. */
function digitsOf(part: string): string {
	let out = "";
	for (const ch of part) out += ARABIC_DIGITS[ch] ?? "";
	return out;
}

/** The part of a run before its first `点`: a digit sequence, or a value when it carries a unit. */
function readWholeNumber(part: string): string | undefined {
	const chars = Array.from(part);
	if (chars.length === 0) return undefined;
	return chars.some((ch) => UNIT_CHARS.has(ch)) ? readValue(chars) : digitsOf(part);
}

/**
 * The value reading of a unit-bearing run: `十六` → `16`, `二百` → `200`, `一百二十三` → `123`,
 * `一千零一` → `1001`, `一万二千` → `12000`.
 *
 * The run is a total (everything already closed by a `万`), a group of at most four places, and a
 * digit still waiting for its unit. A unit with no digit in front of it counts as `一`, which is how
 * `十六` is spoken and why `十` alone reads as `10`.
 */
function readValue(chars: readonly string[]): string | undefined {
	let total = 0;
	let group = 0;
	let digit: number | undefined;

	for (const ch of chars) {
		const arabic = ARABIC_DIGITS[ch];
		if (arabic !== undefined) {
			digit = Number(arabic);
			continue;
		}
		const unit = UNIT_VALUES[ch];
		if (unit === undefined) return undefined;
		if (unit === WAN) {
			const accumulated = group + (digit ?? 0);
			total += (accumulated === 0 ? 1 : accumulated) * unit;
			group = 0;
			digit = undefined;
			continue;
		}
		group += (digit ?? 1) * unit;
		digit = undefined;
	}

	return String(total + group + (digit ?? 0));
}

/** The decimal points in a run; two or more make it a bare version (`零点九九点一`). */
function decimalPoints(run: string): number {
	let count = 0;
	for (const ch of run) if (ch === DECIMAL_POINT) count++;
	return count;
}

/**
 * Read one numeral run into Arabic form, or `undefined` when the shape cannot be read.
 *
 * The characters decide the reading: a run without a unit is a digit sequence and keeps its leading
 * zeros (`零二` → `02`, which is what `a 零二上` needs), a run with a unit is a value (`十六` →
 * `16`). Everything after the first `点` is a decimal part, and a unit inside one (`三点十`) is
 * refused rather than guessed at.
 */
function readNumeralRun(run: string): string | undefined {
	const parts: string[] = [];
	let part = "";
	for (const ch of run) {
		// A character outside the numeral set is not a run this reader may touch.
		if (!NUMERAL_CHARS.has(ch)) return undefined;
		if (ch === DECIMAL_POINT) {
			parts.push(part);
			part = "";
			continue;
		}
		part += ch;
	}
	parts.push(part);

	const whole = readWholeNumber(parts[0] ?? "");
	if (whole === undefined) return undefined;

	const fractions: string[] = [];
	for (const fraction of parts.slice(1)) {
		// An empty part is a leading, trailing or doubled point; a unit after the point is the shape
		// of §4.3's refusal. Neither is a numeral this reader understands.
		if (fraction.length === 0 || [...fraction].some((ch) => UNIT_CHARS.has(ch))) return undefined;
		fractions.push(digitsOf(fraction));
	}

	return [whole, ...fractions].join(".");
}

/** True when `piece` is a token the rule may bind to: one to four Latin letters and/or digits. */
function isBindableToken(piece: string): boolean {
	return piece.length > 0 && piece.length <= LATIN_TOKEN_MAX && LATIN_TOKEN.test(piece);
}

interface NumeralPass {
	text: string;
	converted: number;
}

/**
 * Restore the digits a recogniser spelled as Chinese numerals inside an identifier.
 *
 * The text is cut at its ASCII spaces and every piece is offered to the reader as a candidate run,
 * because the recogniser leaves the numeral as its own word: `k 八 s`, `bf 十六`, `a 零二上`. A run
 * is only converted when a Latin/digit token of at most four characters sits on the side the rule
 * needs (spec §4.3), and only the space the conversion binds across is absorbed — a space next to
 * Han text belongs to the sentence and stays (`八 d 指间` → `8d 指间`).
 *
 * The candidate is always a prefix of a piece, since `零二上复刻` is one piece whose first two
 * characters are the run. A prefix with a Han remainder can be bound from the left (`a 零二上`), and
 * a bare version needs no neighbour at all, but a run bound from the right must be its whole piece:
 * the Latin token has to sit against the numeral, not against a Han character after it (`四卡 h200`
 * is left alone).
 *
 * The passes repeat until nothing changes, because a restored digit is a token in its own right and
 * can license the run it left behind: `a 八 零二` is `a802` and `kubernetes 八 八 a` is
 * `kubernetes 88a`. That fixed point is what makes a second call a no-op (spec §5.2's idempotence),
 * and the loop ends because every pass that changes anything deletes a numeral character for good.
 */
function convertIdentifierNumerals(text: string): NumeralPass {
	let current = text;
	let converted = 0;

	for (;;) {
		const pass = convertNumeralsOnce(current);
		if (pass.converted === 0) return { text: current, converted };
		current = pass.text;
		converted += pass.converted;
	}
}

/** One left-to-right sweep of the numeral rule; a sweep can leave a run for the next one to license. */
function convertNumeralsOnce(text: string): NumeralPass {
	const pieces = text.split(SPACE);
	const rewritten = pieces.map((piece) => piece);
	/** Indexes of pieces whose separating space the conversion absorbed. */
	const absorbed = new Set<number>();
	let converted = 0;

	for (let i = 0; i < pieces.length; i++) {
		const piece = pieces[i] ?? "";
		const run = numeralPrefix(piece);
		if (run.length === 0) continue;

		const value = readNumeralRun(run);
		// A shape the reader refuses is left exactly as it was dictated.
		if (value === undefined) continue;

		const remainder = piece.slice(run.length);
		const afterToken = i > 0 && isBindableToken(rewritten[i - 1] ?? "");
		const beforeToken = remainder.length === 0 && i + 1 < pieces.length && isBindableToken(pieces[i + 1] ?? "");
		const bareVersion = remainder.length === 0 && decimalPoints(run) >= 2;
		if (!afterToken && !beforeToken && !bareVersion) continue;

		rewritten[i] = value + remainder;
		converted++;
		if (afterToken) absorbed.add(i);
		if (beforeToken) absorbed.add(i + 1);
	}

	if (converted === 0) return { text, converted: 0 };

	let out = "";
	for (let i = 0; i < rewritten.length; i++) {
		if (i > 0 && !absorbed.has(i)) out += SPACE;
		out += rewritten[i];
	}
	return { text: out, converted };
}

// ─── The step ────────────────────────────────────────────────────────────────

function unchanged(text: string, status: CleanupStatus): CleanupResult {
	return { text, status, fillersRemoved: 0, numeralsConverted: 0 };
}

/**
 * Clean `text` according to the two switches and report what happened.
 *
 * The two classes are independent, so each pass runs only on its own switch and neither can turn
 * the other on. Fillers go first, because a particle can sit exactly where the numeral rule needs a
 * token: `k 呃 八 s` is `k8s`, while the other order would leave `k 八 s` behind.
 *
 * Every branch returns a string — throwing is not part of this module's contract; the fail-open
 * guard of invariant 1 is the caller's `try/catch` around the whole completion path. Whenever
 * nothing is rewritten — both switches off, no particle or identifier present, or a rewrite that
 * would have emptied the transcript — the input is returned verbatim.
 */
export function cleanTranscript(text: string, options: CleanupOptions): CleanupResult {
	if (!options.fillers && !options.numerals) return unchanged(text, "off");

	let current = text;
	let fillersRemoved = 0;
	let numeralsConverted = 0;

	if (options.fillers) {
		const fillers = removeFillerParticles(current);
		current = fillers.text;
		fillersRemoved = fillers.removed;
	}
	if (options.numerals) {
		const numerals = convertIdentifierNumerals(current);
		current = numerals.text;
		numeralsConverted = numerals.converted;
	}

	// Invariant 2 — cleanup may not delete a dictation.
	if (current.trim().length === 0) return unchanged(text, "nothing-to-do");
	if (current === text) return unchanged(text, "nothing-to-do");

	return { text: current, status: "applied", fillersRemoved, numeralsConverted };
}
