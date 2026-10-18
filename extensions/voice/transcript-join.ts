/**
 * How transcript segments meet.
 *
 * Spec: docs/superpowers/specs/2026-09-26-polish-pipeline-design.md §4 — join with no separator
 * when both sides of a boundary end/begin with a CJK character, a single space otherwise.
 *
 * The long-audio path may cut a dictation at a pause, so a Chinese sentence can come back in pieces;
 * stitching those with a space is what produces "是 什么时候" and "一个 类似于".
 * Latin words still need the space, which is why the rule is per boundary and not a global strip.
 */

/** Han ideographs, including the supplementary planes. Everything else is "not CJK" here. */
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{3fffd}]/u;

/** CJK punctuation a recogniser or the punctuation step can leave sitting on a segment edge. */
const CJK_PUNCTUATION = "。，、；：！？「」『』（）《》〈〉【】〔〕";

function isCjk(ch: string): boolean {
	return ch.length > 0 && (HAN.test(ch) || CJK_PUNCTUATION.includes(ch));
}

function firstChar(text: string): string {
	const codePoint = text.codePointAt(0);
	return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
}

function lastChar(text: string): string {
	// A trailing surrogate pair reads back as a lone low surrogate from `codePointAt(length - 1)`,
	// so step back one unit and take the pair instead.
	const tail = text.codePointAt(text.length - 1);
	if (tail === undefined) return "";
	if (tail >= 0xdc00 && tail <= 0xdfff && text.length >= 2) {
		return String.fromCodePoint(text.codePointAt(text.length - 2) ?? 0);
	}
	return String.fromCodePoint(tail);
}

/**
 * Join decoded segment texts into one transcript.
 *
 * Empty and whitespace-only parts are dropped: a segment that decoded to nothing must not leave a
 * dangling separator behind. Each part is trimmed before its boundary is inspected, because the
 * separator decision belongs to the first and last real characters of the pieces being joined.
 */
export function joinTranscriptParts(parts: readonly string[]): string {
	const kept = parts.map((part) => part.trim()).filter((part) => part.length > 0);
	if (kept.length === 0) return "";

	let out = kept[0] ?? "";
	for (const part of kept.slice(1)) {
		out += isCjk(lastChar(out)) && isCjk(firstChar(part)) ? part : " " + part;
	}
	return out;
}
