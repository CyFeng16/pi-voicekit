import { describe, expect, test } from "bun:test";
import {
	insertTranscript,
	MAX_CHUNK_CHARS,
	MAX_CHUNK_LINES,
	planChunks,
	type EditorSinkHost,
} from "../extensions/voice/editor-sink";

/**
 * The editor sink is the only path from a finished transcript into the user's editor, so these
 * tests assert two things at once: the chunks stay under the host's collapse threshold, and the
 * text reaches the buffer exactly once, whatever the host does on the way.
 */

/** The host's own normalisation before it measures a paste (`editor.js:951-953`). */
function normalise(text: string): string {
	return text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
}

/** The host's large-paste threshold (`editor.js:1085-1095`). */
const HOST_MAX_PASTE_LINES = 10;
const HOST_MAX_PASTE_CHARS = 1000;

type PasteOutcome = "land" | "throw-before" | "throw-after";

interface FakeHostOptions {
	hasUI?: boolean;
	initial?: string;
	/** Cursor offset into the initial buffer; defaults to its end. */
	cursor?: number;
	/** Receives the paste call index (0-based) and decides what the host does. */
	onPaste?: (index: number, text: string) => PasteOutcome;
	onReplace?: (index: number, text: string) => "land" | "throw";
}

/**
 * A stand-in for `ctx.ui` that behaves like the real editor: it normalises, drops control
 * characters, prepends the path-leading space, collapses oversized pastes into a `[paste #N]`
 * marker, and inserts at the cursor. `getEditorText()` expands the markers back, exactly as the
 * real verb does, so `raw` is what the assertions use to prove nothing was collapsed.
 */
function createFakeHost(options: FakeHostOptions = {}) {
	let buffer = options.initial ?? "";
	let cursor = options.cursor ?? buffer.length;

	const pastes: string[] = [];
	const replaces: string[] = [];
	const debugs: Array<{ message: string; meta?: unknown }> = [];
	const pastesById = new Map<number, string>();
	let pasteCounter = 0;
	let reads = 0;

	function expand(text: string): string {
		return text.replace(/\[paste #(\d+)[^\]]*\]/g, (marker, id: string) => pastesById.get(Number(id)) ?? marker);
	}

	const host: EditorSinkHost = {
		hasUI: options.hasUI ?? true,

		getEditorText(): string {
			reads++;
			return expand(buffer);
		},

		pasteToEditor(text: string): void {
			const index = pastes.length;
			const outcome = options.onPaste?.(index, text) ?? "land";
			pastes.push(text);
			if (outcome === "throw-before") throw new Error(`paste ${index} failed before landing`);

			// `handlePaste`: normalise, filter, then maybe prepend the path-leading space.
			let filtered = normalise(text)
				.split("")
				.filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
				.join("");
			const charBeforeCursor = cursor > 0 ? (buffer[cursor - 1] ?? "") : "";
			if (/^[/~.]/.test(filtered) && /\w/.test(charBeforeCursor)) filtered = " " + filtered;

			const lines = filtered.split("\n").length;
			if (lines > HOST_MAX_PASTE_LINES || filtered.length > HOST_MAX_PASTE_CHARS) {
				pasteCounter++;
				pastesById.set(pasteCounter, filtered);
				const marker =
					lines > HOST_MAX_PASTE_LINES
						? `[paste #${pasteCounter} +${lines} lines]`
						: `[paste #${pasteCounter} ${filtered.length} chars]`;
				buffer = buffer.slice(0, cursor) + marker + buffer.slice(cursor);
				cursor += marker.length;
			} else {
				buffer = buffer.slice(0, cursor) + filtered + buffer.slice(cursor);
				cursor += filtered.length;
			}

			if (outcome === "throw-after") throw new Error(`paste ${index} failed after landing`);
		},

		setEditorText(text: string): void {
			const index = replaces.length;
			replaces.push(text);
			if (options.onReplace?.(index, text) === "throw") throw new Error(`replace ${index} failed`);
			// `Editor.setText()` normalises and forces the cursor to the end.
			buffer = normalise(text);
			cursor = buffer.length;
		},

		debug(message: string, meta?: unknown): void {
			debugs.push({ message, meta });
		},
	};

	return {
		host,
		pastes,
		replaces,
		debugs,
		get raw(): string {
			return buffer;
		},
		get reads(): number {
			return reads;
		},
	};
}

function assertWithinHostThresholds(chunks: readonly string[]): void {
	for (const chunk of chunks) {
		const measured = normalise(chunk);
		expect(measured.split("\n").length).toBeLessThanOrEqual(MAX_CHUNK_LINES);
		expect(measured.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
	}
}

describe("planChunks — the host's collapse threshold", () => {
	test("no chunk exceeds the host threshold after normalisation", () => {
		// Eight lines, every line prefixed with 40 tabs: short as source, long once the host
		// expands the tabs. A chunker that measured the source would emit one oversized paste.
		const tabHeavy = Array.from({ length: 8 }, (_, i) => "\t".repeat(40) + `${i}`.repeat(39)).join("\n");
		expect(tabHeavy.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);

		const chunks = planChunks(tabHeavy);
		expect(chunks.length).toBeGreaterThan(1);
		assertWithinHostThresholds(chunks);
		expect(chunks.join("")).toBe(tabHeavy);
	});

	test("short lines are packed up to the line budget", () => {
		const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
		const chunks = planChunks(text);
		assertWithinHostThresholds(chunks);
		expect(chunks.join("")).toBe(text);
		// Seven newlines per chunk at most, and each unit keeps its own newline: 7 + 7 + 6 lines.
		expect(chunks.map((chunk) => chunk.split("\n").length)).toEqual([8, 8, 6]);
	});

	test("a CR-only slice is split on the host's line count, not just on characters", () => {
		// 20 lines in 100 characters: the host normalises every lone CR to a newline and counts
		// lines in the pasted text, so the character budget alone would not keep this one chunk.
		const text = "cell\r".repeat(20);
		const chunks = planChunks(text);
		expect(chunks.length).toBe(3);
		assertWithinHostThresholds(chunks);
		expect(chunks.join("")).toBe(text);
	});

	test("a single line longer than the budget is split on the length budget", () => {
		const chunks = planChunks("x".repeat(2500));
		assertWithinHostThresholds(chunks);
		expect(chunks.map((chunk) => chunk.length)).toEqual([MAX_CHUNK_CHARS, MAX_CHUNK_CHARS, 700]);
	});

	test("a CRLF pair is never split across two chunks", () => {
		const text = "y".repeat(880) + "\r\n" + "z".repeat(1500);
		const chunks = planChunks(text);
		assertWithinHostThresholds(chunks);
		expect(chunks.join("")).toBe(text);
		for (let i = 0; i < chunks.length - 1; i++) {
			expect(chunks[i]?.endsWith("\r") && chunks[i + 1]?.startsWith("\n")).toBe(false);
		}
	});

	test("nothing is dropped or duplicated for any shape we plan", () => {
		const shapes = [
			"",
			"\n",
			"hi",
			"a\n\nb",
			"中文".repeat(400),
			"tab\there",
			"emoji 😀".repeat(300),
			"line\n".repeat(400),
			"\t".repeat(500),
			"\r\n".repeat(400),
		];
		for (const text of shapes) {
			const chunks = planChunks(text);
			expect(chunks.join("")).toBe(text);
			expect(chunks.every((chunk) => chunk.length > 0)).toBe(true);
			assertWithinHostThresholds(chunks);
		}
	});

	test("an empty transcript needs no chunk", () => {
		expect(planChunks("")).toEqual([]);
	});
});

describe("planChunks — the host's path-leading space", () => {
	test("a chunk boundary never manufactures the path-leading space", () => {
		const text = "a".repeat(MAX_CHUNK_CHARS) + ".com";
		const chunks = planChunks(text);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks.slice(1)) expect(/^[/~.]/.test(chunk)).toBe(false);
		expect(chunks.join("")).toBe(text);
	});

	test("the boundary moves back by exactly the one word character it has to", () => {
		const text = "a".repeat(MAX_CHUNK_CHARS) + ".com";
		const chunks = planChunks(text);
		expect(chunks[0]?.length).toBe(MAX_CHUNK_CHARS - 1);
		expect(chunks[1]).toBe("a.com");
	});

	test("a boundary before a path character after a non-word character is left alone", () => {
		const text = "a".repeat(MAX_CHUNK_CHARS - 1) + " " + ".".repeat(MAX_CHUNK_CHARS);
		const chunks = planChunks(text);
		expect(chunks[0]?.length).toBe(MAX_CHUNK_CHARS);
		expect(chunks[0]?.endsWith(" ")).toBe(true);
		expect(chunks[1]?.startsWith(".")).toBe(true);
	});

	test("only the first paste can gain the leading space", () => {
		const chunks = planChunks("/imagine a long dictation");
		expect(chunks.length).toBe(1);
		expect(chunks[0]).toBe("/imagine a long dictation");
	});

	test("a dictation that starts with a path character can gain one leading space", () => {
		// The accepted deviation (spec §5.4): the host does this to the first paste, not to us.
		const fake = createFakeHost({ initial: "prompt", cursor: 6 });
		insertTranscript(fake.host, "/deploy the branch");
		expect(fake.host.getEditorText()).toBe("prompt /deploy the branch");
	});
});

describe("insertTranscript — inserting at the cursor", () => {
	test("the transcript lands once, through pasteToEditor, one planned chunk at a time", () => {
		const fake = createFakeHost();
		const text = "你好，世界。".repeat(200);
		const result = insertTranscript(fake.host, text);

		expect(result).toEqual({ mode: "paste", written: text.length });
		expect(fake.pastes).toEqual(planChunks(text));
		expect(fake.replaces).toEqual([]);
		expect(fake.host.getEditorText()).toBe(text);
		expect(fake.raw).not.toContain("[paste #");
	});

	test("the text lands at the cursor rather than replacing the buffer", () => {
		const fake = createFakeHost({ initial: "before after", cursor: 7 });
		const result = insertTranscript(fake.host, "dictated");
		expect(result.mode).toBe("paste");
		expect(fake.host.getEditorText()).toBe("before dictatedafter");
	});

	test("a long path-like transcript lands verbatim exactly once", () => {
		// Review Focus #2: 3 000 characters, a leading "/", and boundaries that land on ".".
		const text = "/" + "a".repeat(3000) + ".com";
		const fake = createFakeHost({ initial: "prompt: ", cursor: 8 });
		const result = insertTranscript(fake.host, text);

		expect(result).toEqual({ mode: "paste", written: text.length });
		expect(fake.host.getEditorText()).toBe("prompt: " + text);
		expect(fake.raw).not.toContain("[paste #");
		expect(fake.replaces).toEqual([]);
	});

	test("tab expansion and CRLF collapse come from the host, not from us", () => {
		const fake = createFakeHost();
		const text = "one\ttwo\r\nthree\rfour";
		const result = insertTranscript(fake.host, text);
		expect(result.mode).toBe("paste");
		expect(fake.host.getEditorText()).toBe("one    two\nthree\nfour");
		expect(result.written).toBe(text.length);
	});

	test("no UI means no write at all", () => {
		const fake = createFakeHost({ hasUI: false });
		expect(insertTranscript(fake.host, "hi")).toEqual({ mode: "no-ui", written: 0 });
		expect(fake.pastes).toEqual([]);
		expect(fake.replaces).toEqual([]);
		expect(fake.reads).toBe(0);
		expect(fake.debugs).toEqual([]);
	});

	test("an empty transcript writes nothing", () => {
		const fake = createFakeHost();
		expect(insertTranscript(fake.host, "")).toEqual({ mode: "paste", written: 0 });
		expect(fake.pastes).toEqual([]);
		expect(fake.replaces).toEqual([]);
		expect(fake.reads).toBe(0);
	});
});

describe("insertTranscript — recovery from a throwing paste", () => {
	// The real `pasteToEditor` never throws; this path exists for a host that does.
	test("a chunk that throws before mutating is retried as a remainder, exactly once", () => {
		// Distinguishable lines, so a write that restarted from the top would be visible.
		const text = Array.from({ length: 30 }, (_, i) => `line-${i} `.repeat(9)).join("\n");
		const chunks = planChunks(text);
		expect(chunks.length).toBeGreaterThanOrEqual(3);
		const fake = createFakeHost({ onPaste: (index) => (index === 1 ? "throw-before" : "land") });

		const result = insertTranscript(fake.host, text);

		expect(result.mode).toBe("remainder");
		// Pasting stops at the failure; the remainder goes in with one whole-buffer write.
		expect(fake.pastes).toEqual(chunks.slice(0, 2));
		expect(fake.replaces).toEqual([text]);
		// The failed chunk never landed, so its text is part of the remainder — not lost, not repeated.
		expect(fake.replaces[0]).not.toBe((chunks[0] ?? "") + text);
		expect(fake.host.getEditorText()).toBe(text);
		expect(result.written).toBe(text.length);
	});

	test("a chunk that lands before throwing is not written a second time", () => {
		const text = "b".repeat(3000);
		const fake = createFakeHost({ onPaste: (index) => (index === 1 ? "throw-after" : "land") });

		const result = insertTranscript(fake.host, text);

		expect(result.mode).toBe("remainder");
		// The buffer changed, so the chunk counts as delivered: only what follows it is appended.
		expect(fake.replaces).toEqual([text]);
		expect(fake.host.getEditorText()).toBe(text);
		expect(result.written).toBe(text.length);
	});

	test("a throw on the last chunk, after it landed, leaves nothing to append", () => {
		const text = "c".repeat(3000);
		const chunks = planChunks(text);
		const fake = createFakeHost({
			onPaste: (index) => (index === chunks.length - 1 ? "throw-after" : "land"),
		});

		const result = insertTranscript(fake.host, text);

		expect(result).toEqual({ mode: "paste", written: text.length });
		expect(fake.replaces).toEqual([]);
		expect(fake.host.getEditorText()).toBe(text);
	});

	test("a first chunk that threw is recovered from the untouched buffer", () => {
		const fake = createFakeHost({ initial: "keep me", cursor: 7, onPaste: () => "throw-before" });
		const result = insertTranscript(fake.host, "hello world");

		expect(result.mode).toBe("remainder");
		expect(fake.replaces).toEqual(["keep mehello world"]);
		expect(fake.host.getEditorText()).toBe("keep mehello world");
	});

	test("the recovery is reported on the debug channel without the transcript itself", () => {
		const fake = createFakeHost({ onPaste: () => "throw-before" });
		insertTranscript(fake.host, "the dictated words are private");
		expect(fake.debugs.length).toBe(1);
		expect(JSON.stringify(fake.debugs)).not.toContain("private");
	});

	test("a remainder write that also fails is reported as a fallback", () => {
		const text = "d".repeat(3000);
		const fake = createFakeHost({ onPaste: () => "throw-before", onReplace: () => "throw" });

		const result = insertTranscript(fake.host, text);

		expect(result.mode).toBe("fallback");
		expect(result.written).toBe(0);
		expect(fake.pastes.length).toBe(1);
		expect(fake.replaces.length).toBe(1);
		expect(fake.host.getEditorText()).toBe("");
	});
});

describe("insertTranscript — written is a lower bound", () => {
	const texts = ["hi", "a".repeat(3000), "\t".repeat(500), "line\n".repeat(400), "/" + "a".repeat(2000) + ".com"];

	test("written never exceeds the source length, whatever the host does", () => {
		for (const text of texts) {
			for (const outcome of ["land", "throw-before", "throw-after"] as const) {
				for (const failAt of [0, 1]) {
					const fake = createFakeHost({ onPaste: (index) => (index === failAt ? outcome : "land") });
					const result = insertTranscript(fake.host, text);
					expect(result.written).toBeLessThanOrEqual(text.length);
					expect(result.written).toBeGreaterThanOrEqual(0);
					// Whatever happened, the buffer holds the text once and only once.
					expect(fake.host.getEditorText()).toBe(normalise(text));
				}
			}
		}
	});
});
