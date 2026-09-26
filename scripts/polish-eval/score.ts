/**
 * Metrics for the transcript post-processing evaluation.
 *
 * The pass is text in, text out, so the whole acceptance measurement can run
 * offline: these functions compare a raw transcript, the polished text and a
 * ground-truth reference and produce the numbers the design record's acceptance
 * gates are stated in terms of - correction gain, false-edit rate, and the safety
 * flags that decide whether a sample lost meaning.
 *
 * Two deliberate choices:
 *
 * - Case is preserved everywhere. Terminology and code identifiers are
 *   case-sensitive, so folding case would hide exactly the errors this measures.
 *   Normalisation unifies width and whitespace only.
 * - The flags are conservative. A flagged sample goes to a human, so a metric
 *   that misses a real meaning change is worse than one that asks about a
 *   harmless rewrite. Where a heuristic cannot tell - a token the pass merged
 *   with its neighbour, for instance - it flags.
 *
 * Spec: docs/superpowers/specs/2026-09-26-stt-post-processing-design.md (6)
 */

/** Filler words the prompt explicitly allows removing when they carry no meaning. */
const FILLERS = new Set([
	"那个",
	"这个",
	"就是",
	"然后",
	"嗯",
	"呃",
	"啊",
	"额",
	"like",
	"you",
	"know",
	"I",
	"mean",
	"um",
	"uh",
	"er",
]);

/** CJK punctuation and full-width symbol ranges: removed wherever they appear. */
const CJK_PUNCTUATION =
	/[\u2010-\u2027\u2026\u2030\u203b\u3000-\u303f\ufe30-\ufe4f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/g;

/**
 * ASCII punctuation next to a CJK character. NFKC folds most full-width marks
 * (，！？) to their ASCII forms, so a punctuation-only difference would otherwise
 * split a Chinese sentence into extra tokens and look like dropped content.
 * Punctuation between two ASCII characters is left alone: it belongs to
 * identifiers and numbers (base_url, 3.14, /v2).
 */
const CJK_ADJACENT_PUNCTUATION =
	/(?<=[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af])[,.;:!?'"()[\]{}<>]|[,.;:!?'"()[\]{}<>](?=[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af])/g;

/** Everything that separates words rather than belonging to one. */
function stripSeparators(chunk: string): string {
	return chunk.replace(CJK_PUNCTUATION, "").replace(CJK_ADJACENT_PUNCTUATION, "");
}

/** ASCII punctuation stripped only from a token's edges, never from inside it. */
const EDGE_PUNCTUATION = /^[,.;:!?'"()[\]{}<>|~`^*+=&#@$%]+|[,.;:!?'"()[\]{}<>|~`^*+=&#@$%]+$/g;

const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
const LATINISH_CHAR = /[A-Za-z0-9\u00c0-\u024f]/;

/** NFKC unifies width; whitespace collapses; case stays exactly as it was. */
export function normalizeForComparison(text: string): string {
	return text
		.normalize("NFKC")
		.replace(/[\s\u3000]+/g, " ")
		.trim();
}

/** Everything that carries no wording: used to detect punctuation-only edits. */
function stripToWording(text: string): string {
	return normalizeForComparison(text)
		.replace(CJK_PUNCTUATION, "")
		.replace(/[\s,.;:!?'"()[\]{}<>|~`^*+=&#@$%]/g, "");
}

/** Split a chunk at script boundaries so `改base_url就行` yields three tokens. */
function splitByScript(chunk: string): string[] {
	const pieces: string[] = [];
	const chars = Array.from(chunk);
	let current = "";
	let currentIsCjk: boolean | undefined;
	const flush = () => {
		if (current) pieces.push(current);
		current = "";
	};
	for (let index = 0; index < chars.length; index += 1) {
		const char = chars[index] ?? "";
		const isCjk = CJK_CHAR.test(char);
		const isWording = isCjk || LATINISH_CHAR.test(char);
		if (!isWording) {
			// Separators live inside identifiers (base_url, /v2, v2.0.1): keep one that
			// continues a token, or that a following word character will continue.
			if (/[/_.-]/.test(char) && (current || LATINISH_CHAR.test(chars[index + 1] ?? ""))) {
				current += char;
				if (!currentIsCjk) currentIsCjk = false;
				continue;
			}
			flush();
			continue;
		}
		if (current && currentIsCjk !== isCjk) flush();
		current += char;
		currentIsCjk = isCjk;
	}
	flush();
	// A piece with no wording is punctuation only; a trailing separator is noise.
	return pieces
		.map((piece) => piece.replace(/[/_.-]+$/, ""))
		.filter((piece) => CJK_CHAR.test(piece) || LATINISH_CHAR.test(piece));
}

/** Comparison tokens: CJK runs stay whole, latin runs stay whole, punctuation goes. */
export function tokenize(text: string): string[] {
	const tokens: string[] = [];
	for (const chunk of normalizeForComparison(text).split(" ")) {
		if (!chunk) continue;
		for (const piece of splitByScript(stripSeparators(chunk))) {
			const token = piece.replace(EDGE_PUNCTUATION, "");
			if (token) tokens.push(token);
		}
	}
	return tokens;
}

/**
 * Flag-level units: one Chinese character and one latin run at a time. The word-level
 * tokens above keep a whole CJK run together, which is right for a word error rate and
 * wrong for "did anything lose meaning": editing one character of 把过期时间调短 would
 * otherwise look like a dropped clause next to an invented one.
 */
export function wordingUnits(text: string): string[] {
	const units: string[] = [];
	for (const token of tokenize(text)) {
		if (!CJK_CHAR.test(token)) {
			units.push(token);
			continue;
		}
		for (const char of token) if (CJK_CHAR.test(char)) units.push(char);
	}
	return units;
}

function countTokens(tokens: readonly string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
	return counts;
}

/** Elements present in both multisets, counted. */
function sharedCount(a: Map<string, number>, b: Map<string, number>): Map<string, number> {
	const shared = new Map<string, number>();
	for (const [key, count] of a) {
		const other = b.get(key);
		if (other) shared.set(key, Math.min(count, other));
	}
	return shared;
}

function levenshtein<T>(a: readonly T[], b: readonly T[]): number {
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i += 1) {
		const current = [i];
		for (let j = 1; j <= b.length; j += 1) {
			const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
		}
		previous = current;
	}
	return previous[b.length];
}

/**
 * Character error rate against the reference. Whitespace is not counted: a pass
 * that only re-spaces text has not introduced an error.
 */
export function cer(reference: string, hypothesis: string): number {
	const ref = Array.from(stripToWording(reference));
	const hyp = Array.from(stripToWording(hypothesis));
	if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
	return levenshtein(ref, hyp) / ref.length;
}

/** Word error rate against the reference, over comparison tokens. */
export function wer(reference: string, hypothesis: string): number {
	const ref = tokenize(reference);
	const hyp = tokenize(hypothesis);
	if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
	return levenshtein(ref, hyp) / ref.length;
}

export interface CorrectionGain {
	cerBefore: number;
	cerAfter: number;
	werBefore: number;
	werAfter: number;
	/** Positive means the pass moved the text toward the reference. */
	cerGain: number;
	werGain: number;
}

export function correctionGain(raw: string, polished: string, groundTruth: string): CorrectionGain {
	const cerBefore = cer(groundTruth, raw);
	const cerAfter = cer(groundTruth, polished);
	const werBefore = wer(groundTruth, raw);
	const werAfter = wer(groundTruth, polished);
	return { cerBefore, cerAfter, werBefore, werAfter, cerGain: cerBefore - cerAfter, werGain: werBefore - werAfter };
}

/** Punctuation marks, counted as a bag. NFKC folds the full-width forms to ASCII. */
const PUNCTUATION_MARKS = "。！？；：、，,.!?;:";

function punctuationCounts(text: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const char of normalizeForComparison(text)) {
		if (!PUNCTUATION_MARKS.includes(char)) continue;
		counts.set(char, (counts.get(char) ?? 0) + 1);
	}
	return counts;
}

export interface PunctuationScore {
	/** F1 over the punctuation bag against the reference, before and after the pass. */
	before: number;
	after: number;
}

function punctuationF1(reference: string, hypothesis: string): number {
	const expected = punctuationCounts(reference);
	const actual = punctuationCounts(hypothesis);
	let expectedTotal = 0;
	let actualTotal = 0;
	let matched = 0;
	for (const [, count] of expected) expectedTotal += count;
	for (const [, count] of actual) actualTotal += count;
	for (const [mark, count] of expected) matched += Math.min(count, actual.get(mark) ?? 0);
	if (expectedTotal === 0 && actualTotal === 0) return 1;
	if (expectedTotal === 0 || actualTotal === 0) return 0;
	const precision = matched / actualTotal;
	const recall = matched / expectedTotal;
	return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

/**
 * Punctuation is its own dimension: restoring it is part of the pass's stated job, and
 * it is invisible to the character and word error rates, which compare wording only.
 * The bag ignores where a mark sits, so it measures whether punctuation came back in the
 * right proportions rather than whether every comma landed exactly where the speaker meant.
 */
export function punctuationScore(raw: string, polished: string, groundTruth: string): PunctuationScore {
	return { before: punctuationF1(groundTruth, raw), after: punctuationF1(groundTruth, polished) };
}
export interface FalseEditReport {
	/** Reference tokens the pass supplied that were missing or wrong before. */
	fixed: number;
	/** Reference tokens that were already right and the pass changed or removed. */
	falseEdits: number;
	/** Tokens that appear in neither the raw transcript nor the reference. */
	invented: string[];
	falseEditRate: number;
	tokensCorrectBefore: number;
}

/**
 * Compare what the pass changed against the reference. A change is a fix only
 * when it moves toward the reference; a change away from it - or a change to
 * something that was already right - is a false edit.
 */
export function falseEditReport(raw: string, polished: string, groundTruth: string): FalseEditReport {
	const rawTokens = wordingUnits(raw);
	const polishedTokens = wordingUnits(polished);
	const referenceTokens = wordingUnits(groundTruth);
	const reference = countTokens(referenceTokens);
	const before = sharedCount(countTokens(rawTokens), reference);
	const after = sharedCount(countTokens(polishedTokens), reference);
	let fixed = 0;
	for (const [token, count] of after) fixed += Math.max(0, count - (before.get(token) ?? 0));
	let falseEdits = 0;
	for (const [token, count] of before) falseEdits += Math.max(0, count - (after.get(token) ?? 0));
	const rawCounts = countTokens(rawTokens);
	const polishedCounts = countTokens(polishedTokens);
	const invented: string[] = [];
	for (const [token, count] of polishedCounts) {
		const known = (rawCounts.get(token) ?? 0) + (reference.get(token) ?? 0);
		if (count > known) invented.push(token);
	}
	const tokensCorrectBefore = [...before.values()].reduce((sum, count) => sum + count, 0);

	// A change that leaves the wording identical is a punctuation or spacing edit.
	if (stripToWording(raw) === stripToWording(polished)) {
		return { fixed: 0, falseEdits: 0, invented: [], falseEditRate: 0, tokensCorrectBefore };
	}
	return {
		fixed,
		falseEdits,
		invented,
		falseEditRate: falseEdits / Math.max(1, tokensCorrectBefore),
		tokensCorrectBefore,
	};
}

export interface MeaningRisks {
	/** A number that was right in the raw transcript and is gone or altered. */
	numbersChanged: boolean;
	/** A code identifier or path that was right and is gone or altered. */
	identifiersChanged: boolean;
	/** Reference wording missing from the polished text, fillers aside. */
	contentDropped: boolean;
	/** Wording the speaker never said and the reference does not contain. */
	inventedContent: boolean;
	any: boolean;
}

function isNumeric(token: string): boolean {
	// A bare number: digits with optional separators. `v2` and `8080x` are identifiers, not numbers.
	return /^\d/.test(token) && /^[\d.,:/%-]+$/.test(token);
}

function isIdentifier(token: string): boolean {
	if (/[_/]/.test(token)) return true;
	if (/\d/.test(token) && /[A-Za-z]/.test(token)) return true;
	return /^[a-z]+[A-Z]/.test(token);
}

/**
 * A risk only when the reference expects this kind of token, the raw transcript
 * already had it right, and the polished text no longer does. A token the pass
 * restored is a fix, and a kind of token the reference does not contain cannot be
 * risked at all.
 */
function tokenRisk(
	reference: Map<string, number>,
	raw: Map<string, number>,
	polished: Map<string, number>,
	match: (token: string) => boolean
): boolean {
	const expected = [...reference].filter(([token]) => match(token));
	if (expected.length === 0) return false;
	const wasRight = expected.every(([token, count]) => (raw.get(token) ?? 0) >= count);
	const isRight = expected.every(([token, count]) => (polished.get(token) ?? 0) >= count);
	return wasRight && !isRight;
}

/**
 * The safety half of the score: would a reasonable person say the pass changed
 * what was said? These flags gate the enabled-by-default decision, so each one
 * errs toward flagging.
 */
export function meaningRisks(raw: string, polished: string, groundTruth: string): MeaningRisks {
	const rawTokens = countTokens(wordingUnits(raw));
	const polishedTokens = countTokens(wordingUnits(polished));
	const referenceTokens = countTokens(wordingUnits(groundTruth));
	const edits = falseEditReport(raw, polished, groundTruth);

	const numbersChanged = tokenRisk(referenceTokens, rawTokens, polishedTokens, isNumeric);
	const identifiersChanged = tokenRisk(referenceTokens, rawTokens, polishedTokens, isIdentifier);
	// Fillers are excluded because removing a meaningless one is the pass's job, not a loss.
	const contentDropped = [...referenceTokens].some(([token, count]) => {
		if (isNumeric(token) || isIdentifier(token) || FILLERS.has(token)) return false;
		return (polishedTokens.get(token) ?? 0) < count;
	});
	const inventedContent = edits.invented.some((token) => !FILLERS.has(token));
	return {
		numbersChanged,
		identifiersChanged,
		contentDropped,
		inventedContent,
		any: numbersChanged || identifiersChanged || contentDropped || inventedContent,
	};
}

export type SampleVerdict = "improved" | "unchanged" | "regressed" | "fallback";

export interface SampleInput {
	id: string;
	category: string;
	backend: string;
	raw: string;
	polished: string;
	groundTruth: string;
	status: string;
	reason?: string;
	latencyMs: number;
	contextChars: number;
	arm?: string;
}

export interface SampleScore extends SampleInput {
	applied: boolean;
	verdict: SampleVerdict;
	safetyFlagged: boolean;
	gain: CorrectionGain;
	edits: FalseEditReport;
	punctuation: PunctuationScore;
	risks: MeaningRisks;
}

/** Score one dictation: gain when it ran, and the safety verdict either way. */
export function scoreSample(input: SampleInput): SampleScore {
	const applied = input.status === "applied";
	const gain = correctionGain(input.raw, input.polished, input.groundTruth);
	const edits = falseEditReport(input.raw, input.polished, input.groundTruth);
	const risks = meaningRisks(input.raw, input.polished, input.groundTruth);
	// The verdict reports the direction of the gain. The safety flags are orthogonal
	// and reported separately, because a sample can improve overall while breaking one
	// detail - and it is the flags, not the verdict, that gate the defaults.
	let verdict: SampleVerdict;
	if (!applied) verdict = "fallback";
	else if (gain.cerGain > 1e-9) verdict = "improved";
	else if (gain.cerGain < -1e-9) verdict = "regressed";
	else verdict = "unchanged";
	return {
		...input,
		applied,
		verdict,
		safetyFlagged: risks.any,
		gain,
		edits,
		risks,
		punctuation: punctuationScore(input.raw, input.polished, input.groundTruth),
	};
}

/** Nearest-rank percentile; an empty set has no percentile at all. */
export function p95(values: readonly number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.ceil(0.95 * sorted.length);
	return sorted[Math.max(0, rank - 1)];
}

export function median(values: readonly number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
