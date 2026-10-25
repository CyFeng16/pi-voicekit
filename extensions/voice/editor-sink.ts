/**
 * Puts a finished dictation into the user's editor.
 *
 * Spec: docs/superpowers/specs/2026-10-22-local-streaming-preview-design.md §5.4 items 3-4.
 *
 * `pasteToEditor()` is the only cursor-respecting buffer verb the extension API exposes, and the host
 * rewrites every paste on its way in: CRLF/CR collapse, tabs to four spaces, control characters
 * dropped, one leading space when the paste starts with `/`, `~` or `.` after a word character, and —
 * past 10 lines or 1 000 characters — a `[paste #N]` marker instead of the text. That marker would
 * replace the user's words with a numbered placeholder, so chunks are planned under the host's
 * threshold **as the host measures it**, on the normalised text, and no chunk boundary is allowed to
 * manufacture the path-leading space the host adds once per paste.
 *
 * The sink is pure otherwise: no history, no timers, no state between calls, and the only side
 * effects are the verbs it is handed.
 */

export interface EditorSinkHost {
	hasUI: boolean;
	getEditorText(): string;
	pasteToEditor(text: string): void;
	setEditorText(text: string): void;
	debug?(message: string, meta?: unknown): void;
}

/**
 * How the transcript reached the editor.
 *
 * - `"paste"`: every chunk went through `pasteToEditor` (possibly after a throw that left nothing
 *   to append).
 * - `"remainder"`: a chunk threw; the chunks before the first one that did not land were kept and the
 *   rest was appended with a single `setEditorText()`.
 * - `"fallback"`: a chunk threw and the recovery write threw too — text is missing and the caller
 *   cannot tell which.
 * - `"no-ui"`: there is no editor to write to; no host verb was called.
 *
 * `written` is a **lower bound** on delivered source characters, never an offset to retry from: the
 * host expands tabs and collapses line endings, so `text.slice(written)` is not the unsaved part.
 */
export type SinkResult = { mode: "paste" | "remainder" | "fallback" | "no-ui"; written: number };

/** Chunk budget in normalised characters. The host collapses at 1 000. */
export const MAX_CHUNK_CHARS = 900;

/** Chunk budget in lines. The host collapses at 10 lines. */
export const MAX_CHUNK_LINES = 8;

/** A chunk of `MAX_CHUNK_LINES` lines holds at most this many newlines. */
const MAX_CHUNK_NEWLINES = MAX_CHUNK_LINES - 1;

/** How the host expands a tab before it measures a paste. */
const TAB_WIDTH = 4;

/** The host's test for the character before the cursor, which is what makes it insert a space. */
const WORD_CHAR = /\w/;

/** The three characters the host treats as the start of a pasted path. */
const PATH_LEAD = /^[/~.]/;

interface Size {
	chars: number;
	lines: number;
}

/**
 * How much room a slice takes once the host has normalised it: a tab is four characters, a CRLF pair
 * is one newline, a lone CR is one newline. Everything else costs one UTF-16 unit, which is what the
 * host's `.length` counts, including the control characters it later drops — over-counting only makes
 * a chunk smaller.
 */
function measure(text: string): Size {
	let chars = 0;
	let lines = 0;
	for (let index = 0; index < text.length; index++) {
		const char = text[index] ?? "";
		if (char === "\r" && text[index + 1] === "\n") {
			chars += 1;
			lines += 1;
			index++;
			continue;
		}
		chars += char === "\t" ? TAB_WIDTH : 1;
		if (char === "\n" || char === "\r") lines += 1;
	}
	return { chars, lines };
}

/** The text cut into whole lines, each keeping the newline that ends it (the last one may have none). */
function lineUnits(text: string): string[] {
	const units: string[] = [];
	let start = 0;
	for (let index = 0; index < text.length; index++) {
		if (text[index] === "\n") {
			units.push(text.slice(start, index + 1));
			start = index + 1;
		}
	}
	if (start < text.length) units.push(text.slice(start));
	return units;
}

/**
 * Splits one slice that does not fit in a single chunk, on both budgets at once.
 *
 * A boundary that leaves `/`, `~` or `.` at the head of the next piece is moved back one character,
 * because the host prepends a space to such a paste when the character before the cursor is a word
 * character — and it does that once per paste, so the space would land in the middle of the
 * transcript. Moving the boundary back puts that word character at the head of the next piece
 * instead, which the host leaves alone. Each piece is measured from its own start, so the shift never
 * pushes one over a budget, and a single character always fits, so every pass advances.
 */
function splitToFit(text: string): string[] {
	const pieces: string[] = [];
	let start = 0;

	while (start < text.length) {
		let end = start;
		let chars = 0;
		let lines = 0;
		while (end < text.length) {
			// A CRLF pair is one newline for the host; keeping it whole also keeps it from becoming
			// two newlines, one from each paste, when the boundary falls between the two characters.
			const pair = text[end] === "\r" && text[end + 1] === "\n";
			const char = text[end] ?? "";
			const cost = pair ? 1 : char === "\t" ? TAB_WIDTH : 1;
			const lineCost = pair || char === "\n" || char === "\r" ? 1 : 0;
			if (chars + cost > MAX_CHUNK_CHARS || lines + lineCost > MAX_CHUNK_NEWLINES) break;
			chars += cost;
			lines += lineCost;
			end += pair ? 2 : 1;
		}
		// The boundary moves back at most one character, and only when that character exists in this
		// piece: the budgets are in the hundreds, so the shift always has room.
		const unsafe = PATH_LEAD.test(text[end] ?? "") && WORD_CHAR.test(text[end - 1] ?? "");
		if (end < text.length && unsafe && end - 1 > start) end -= 1;
		pieces.push(text.slice(start, end));
		start = end;
	}

	return pieces;
}

/**
 * Cuts a transcript into pastes that the host will insert verbatim instead of collapsing.
 *
 * Lines come first — a chunk boundary lands on a line boundary whenever one fits — and only a unit
 * that is too big for any chunk on its own is split inside itself. `planChunks(text).join("")` is
 * always `text`, so the caller can rely on the concatenation being lossless.
 */
export function planChunks(text: string): string[] {
	const chunks: string[] = [];
	let current = "";
	let size: Size = { chars: 0, lines: 0 };

	const flush = (): void => {
		if (current.length === 0) return;
		chunks.push(current);
		current = "";
		size = { chars: 0, lines: 0 };
	};

	const pack = (piece: string, pieceSize: Size): void => {
		const fits = size.chars + pieceSize.chars <= MAX_CHUNK_CHARS && size.lines + pieceSize.lines <= MAX_CHUNK_NEWLINES;
		if (!fits) flush();
		current += piece;
		size = { chars: size.chars + pieceSize.chars, lines: size.lines + pieceSize.lines };
	};

	for (const unit of lineUnits(text)) {
		const unitSize = measure(unit);
		if (unitSize.chars <= MAX_CHUNK_CHARS && unitSize.lines <= MAX_CHUNK_NEWLINES) {
			pack(unit, unitSize);
			continue;
		}
		for (const piece of splitToFit(unit)) pack(piece, measure(piece));
	}

	flush();
	return chunks;
}

/**
 * Source characters the host keeps: it drops control characters other than newlines and tabs. A code
 * point counts once, so this stays under the character count `text.length` gives — a lower bound is
 * all `written` claims.
 */
function deliveredChars(text: string): number {
	let count = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (code >= 32 || char === "\n" || char === "\r" || char === "\t") count++;
	}
	return count;
}

/**
 * Recovery after a paste threw.
 *
 * The host inserts atomically and nothing else writes during a synchronous paste, so the buffer
 * **content** decides whether the chunk landed; a length delta cannot, because the host may add a
 * leading space, expand tabs and collapse line endings. Whatever the answer, the text already in the
 * buffer stays and only the chunks from the first one that did not land are appended — once, with
 * `setEditorText()` — so no path drops a character or writes one twice.
 */
function recover(
	host: EditorSinkHost,
	chunks: readonly string[],
	failedIndex: number,
	before: string,
	error: unknown
): SinkResult {
	const after = host.getEditorText();
	const landed = after !== before;
	const firstMissing = landed ? failedIndex + 1 : failedIndex;
	const remainder = chunks.slice(firstMissing).join("");
	const written = deliveredChars(chunks.slice(0, firstMissing).join(""));

	host.debug?.("editor-sink: paste failed", {
		chunk: failedIndex,
		chunks: chunks.length,
		landed,
		remainderChars: remainder.length,
		error: error instanceof Error ? error.message : String(error),
	});

	// Every chunk landed after all: there is nothing to append and nothing was lost.
	if (remainder.length === 0) return { mode: "paste", written };

	try {
		host.setEditorText((landed ? after : before) + remainder);
	} catch (replaceError) {
		host.debug?.("editor-sink: appending the remainder failed too", {
			chunk: failedIndex,
			chunks: chunks.length,
			error: replaceError instanceof Error ? replaceError.message : String(replaceError),
		});
		return { mode: "fallback", written };
	}

	return { mode: "remainder", written: written + deliveredChars(remainder) };
}

/**
 * Inserts a finished transcript at the cursor.
 *
 * Without a UI the runner injects no-op editor verbs, so a missing-method check would never fire and
 * the content comparison in `recover()` would read an always-empty buffer and call every paste
 * failed. `hasUI` is the real gate: without it nothing is called at all.
 */
export function insertTranscript(host: EditorSinkHost, text: string): SinkResult {
	if (!host.hasUI) return { mode: "no-ui", written: 0 };

	const chunks = planChunks(text);
	// Nothing to write. An empty transcript must not reach `setEditorText()`, which would wipe a
	// buffer the user is already typing in.
	if (chunks.length === 0) return { mode: "paste", written: 0 };

	for (let index = 0; index < chunks.length; index++) {
		const before = host.getEditorText();
		try {
			host.pasteToEditor(chunks[index] ?? "");
		} catch (error) {
			return recover(host, chunks, index, before, error);
		}
	}

	return { mode: "paste", written: deliveredChars(text) };
}
