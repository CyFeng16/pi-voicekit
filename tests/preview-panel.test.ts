import { describe, expect, test } from "bun:test";
import { createPreviewPanel } from "../extensions/voice/preview-panel";
import { visualWidth } from "../extensions/voice/ui-width";

/**
 * The preview panel's four promises, pinned as rendered rows rather than through the TUI.
 *
 * Spec: docs/superpowers/specs/2026-10-22-local-streaming-preview-design.md §5.2. The factory form of
 * `setWidget` is uncapped, so the panel is the only thing holding its height: it must show six rows,
 * scrolled to the tail of the dictation, and nothing but the transcript — no header, counter or status
 * label. A row wider than the terminal would wrap outside our six-row budget, so every row it returns
 * has to fit the width it was asked to render at, for wide characters too.
 */

/** A transcript whose rows are obvious: `line 0` … `line 19`. */
function numberedLines(count: number): string {
	return Array.from({ length: count }, (_, i) => `line ${i}`).join("\n");
}

describe("preview panel — the six-row tail window", () => {
	test("renders the last six lines and nothing else", () => {
		const panel = createPreviewPanel(() => numberedLines(20));
		const out = panel.render(80);
		expect(out).toHaveLength(6);
		expect(out[5]).toContain("line 19");
		expect(out.join("\n")).not.toContain("line 13");
	});

	test("a transcript shorter than the window is not padded", () => {
		const panel = createPreviewPanel(() => numberedLines(2));
		expect(panel.render(80)).toEqual(["line 0", "line 1"]);
	});

	test("opts.lines overrides the window height", () => {
		const panel = createPreviewPanel(() => numberedLines(20), { lines: 3 });
		expect(panel.render(80)).toEqual(["line 17", "line 18", "line 19"]);
	});

	test("an empty transcript renders no rows at all", () => {
		const panel = createPreviewPanel(() => "");
		expect(panel.render(80)).toEqual([]);
	});

	test("a trailing newline does not spend a row on a blank line", () => {
		const panel = createPreviewPanel(() => "line 0\nline 1\n");
		expect(panel.render(80)).toEqual(["line 0", "line 1"]);
	});
});

describe("preview panel — transcript text only", () => {
	test("the rows are the text's tail, byte for byte", () => {
		const text = numberedLines(8);
		const panel = createPreviewPanel(() => text);
		// Exactly what the user dictated: no header, no counter, no status label, no colour escapes.
		expect(panel.render(80).join("\n")).toBe(text.split("\n").slice(-6).join("\n"));
	});

	test("the live tail is re-read on every render, not cached", () => {
		let text = "今天";
		const panel = createPreviewPanel(() => text);
		expect(panel.render(80)).toEqual(["今天"]);
		text = "今天天气";
		panel.invalidate();
		expect(panel.render(80)).toEqual(["今天天气"]);
	});

	test("a throwing text source renders nothing instead of throwing the frame", () => {
		const panel = createPreviewPanel(() => {
			throw new Error("composer gone");
		});
		expect(panel.render(80)).toEqual([]);
	});
});

describe("preview panel — width", () => {
	test("does not throw on a narrow width", () => {
		const panel = createPreviewPanel(() => "中文 dictation 中文");
		for (const width of [0, 1, 2, 3, 5]) {
			expect(() => panel.render(width)).not.toThrow();
		}
	});

	test("wraps instead of clipping, so the end of the dictation stays visible", () => {
		const text = "0123456789".repeat(10); // one long line, exactly 100 columns
		const panel = createPreviewPanel(() => text);
		const out = panel.render(10);
		expect(out).toHaveLength(6);
		// Six rows of ten columns are the last sixty characters — the head scrolled out, the tail kept.
		expect(out.join("")).toBe(text.slice(-60));
	});

	test("keeps wide characters whole and inside the width", () => {
		const text = "中文字符".repeat(10); // 40 code points, 80 columns
		const panel = createPreviewPanel(() => text);
		const out = panel.render(10);
		expect(out).toHaveLength(6);
		for (const row of out) expect(visualWidth(row)).toBeLessThanOrEqual(10);
		// No code point was sliced off or dropped: the rows still spell the tail of the transcript.
		// Five glyphs per ten-column row, six rows: the last thirty code points survive intact, and the
		// remainder divides evenly so the window boundary lands on a row boundary.
		expect(out.join("")).toBe(text.slice(-30));
	});
});
