import { describe, expect, test } from "bun:test";
import { assembleContext, DEFAULT_CONTEXT_LIMITS, type EntryLike } from "../extensions/voice/post-process-context";

const msg = (role: "user" | "assistant" | "toolResult", text: string): EntryLike => ({
	type: "message",
	message: { role, content: [{ type: "text", text }] },
});

const limits = { ...DEFAULT_CONTEXT_LIMITS, turns: 2 };

describe("assembleContext", () => {
	test("keeps the newest turns and restores chronological order", () => {
		const entries = [
			msg("user", "first"),
			msg("assistant", "one"),
			msg("user", "second"),
			msg("assistant", "two"),
			msg("user", "third"),
		];
		const result = assembleContext(entries, limits);
		expect(result.turns.map((t) => t.text)).toEqual(["second", "two", "third"]);
	});

	test("counts an incomplete trailing turn and keeps whole turns intact", () => {
		const result = assembleContext(
			[msg("user", "older"), msg("assistant", "reply"), msg("user", "just dictated")],
			limits
		);
		expect(result.turns.map((t) => t.text)).toEqual(["older", "reply", "just dictated"]); // 2 turns requested, 2 turns present
	});

	test("counts an image-only user message as a turn and keeps the reply that follows it", () => {
		const entries: EntryLike[] = [
			msg("user", "earlier question"),
			msg("assistant", "earlier answer"),
			{ type: "message", message: { role: "user", content: [{ type: "image", data: "aGk=" }] } },
			msg("assistant", "answer to the image"),
		];
		const result = assembleContext(entries, { ...DEFAULT_CONTEXT_LIMITS, turns: 1 });
		// The image-only message consumes the newest turn even though it carries no text,
		// so the turn before it is not what "the last 1 user turn" means.
		expect(result.turns.map((t) => t.text)).toEqual(["answer to the image"]);
		expect(result.turns.map((t) => t.text).join("|")).not.toContain("earlier");
	});

	test("drops tool results and thinking content, keeps assistant prose", () => {
		const entries: EntryLike[] = [
			msg("user", "hello"),
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "secret" },
						{ type: "toolCall", name: "read", arguments: { path: "/etc/x" } },
						{ type: "text", text: "visible" },
					],
				},
			},
			{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "tool output" }] } },
		];
		const result = assembleContext(entries, limits);
		const joined = result.turns.map((t) => t.text).join("|");
		expect(joined).toContain("visible");
		expect(joined).not.toContain("secret");
		expect(joined).not.toContain("read(");
		expect(joined).not.toContain("tool output");
	});

	test("never surfaces the compaction summary, even when the entries carry one", () => {
		const entries: EntryLike[] = [
			{ type: "compaction", summary: "earlier: we set up the parser" },
			msg("user", "carry on"),
		];
		const result = assembleContext(entries, limits);
		// Dropped after the first acceptance round: it cost a disclosure category without
		// measuring a gain over the turns alone.
		expect(JSON.stringify(result)).not.toContain("earlier");
		expect(result.turns.map((t) => t.text)).toEqual(["carry on"]);
	});

	test("turns = 0 yields no context at all", () => {
		const entries: EntryLike[] = [{ type: "compaction", summary: "earlier" }, msg("user", "a"), msg("assistant", "b")];
		const result = assembleContext(entries, { ...limits, turns: 0 });
		expect(result.turns).toEqual([]);
		expect(result.characters).toBe(0);
	});

	test("truncates a long entry from the head and flags it", () => {
		const long = "x".repeat(50);
		const result = assembleContext([msg("user", long)], { turns: 1, perEntryChars: 10, totalChars: 4000 });
		// The cap now includes the elision marker: 9 kept characters + "…" = 10.
		expect(result.turns[0]!.text).toBe("xxxxxxxxx…");
		expect(result.truncated).toBe(true);
	});

	test("drops the oldest turns when the total budget is exceeded", () => {
		const entries = [msg("user", "old"), msg("assistant", "older reply"), msg("user", "new")];
		const result = assembleContext(entries, { turns: 2, perEntryChars: 500, totalChars: 6 });
		expect(result.turns.map((t) => t.text)).toEqual(["new"]);
		expect(result.characters).toBeLessThanOrEqual(6);
	});

	test("survives malformed and unknown entries", () => {
		const entries: EntryLike[] = [
			{ type: "usage" },
			{},
			{ type: "message" },
			{ type: "message", message: { role: "user" } },
			msg("user", "ok"),
		];
		expect(() => assembleContext(entries, limits)).not.toThrow();
		expect(assembleContext(entries, limits).turns.map((t) => t.text)).toEqual(["ok"]);
	});

	test("does not let a compaction entry consume the turn budget", () => {
		const entries: EntryLike[] = [{ type: "compaction", summary: "s".repeat(50) }, msg("user", "short")];
		const caps = { turns: 1, perEntryChars: 500, totalChars: 20 };
		const result = assembleContext(entries, caps);
		expect(result.turns.map((t) => t.text)).toEqual(["short"]);
		expect(result.characters).toBe(5);
		expect(result.truncated).toBe(false);
	});

	test("drops whole turns, never an assistant entry without its user entry", () => {
		const entries = [msg("user", "aaaa"), msg("assistant", "b"), msg("user", "cccc")];
		// Entry-by-entry trimming would drop "aaaa" only and keep ["b", "cccc"].
		const result = assembleContext(entries, { turns: 2, perEntryChars: 500, totalChars: 8 });
		expect(result.turns.map((t) => t.text)).toEqual(["cccc"]);
		expect(result.turns[0]!.role).toBe("user");
		expect(result.characters).toBeLessThanOrEqual(8);
	});

	test("floors a fractional turn limit instead of losing it", () => {
		const entries = [msg("user", "first"), msg("assistant", "one"), msg("user", "second"), msg("assistant", "two")];
		// slice(1.5) would resolve to slice(0) and keep the whole history.
		const result = assembleContext(entries, { turns: 1.5, perEntryChars: 500, totalChars: 4000 });
		expect(result.turns.map((t) => t.text)).toEqual(["second", "two"]);
	});

	test("treats a non-finite turn limit as no context, not as no limit", () => {
		const entries = [msg("user", "first"), msg("user", "second")];
		const caps = { perEntryChars: 500, totalChars: 4000 };
		expect(assembleContext(entries, { ...caps, turns: Number.NaN }).turns).toEqual([]);
		expect(assembleContext(entries, { ...caps, turns: Number.POSITIVE_INFINITY }).turns).toEqual([]);
	});

	test("counts the elision marker so characters can equal the budget but never exceed it", () => {
		const caps = { turns: 1, perEntryChars: 500, totalChars: 11 };
		const result = assembleContext([msg("user", "x".repeat(30))], caps);
		// 10 kept characters + "…" fills the 11-character budget exactly.
		expect(result.turns[0]!.text).toBe("x".repeat(10) + "…");
		expect(result.characters).toBe(caps.totalChars);
		expect(result.characters).toBeLessThanOrEqual(caps.totalChars);
	});

	test("never emits a lone surrogate when the head cut splits a pair", () => {
		// "abc😀def" — the cut at index 4 falls between the pair's code units.
		const result = assembleContext([msg("user", "abc😀def")], { turns: 1, perEntryChars: 5, totalChars: 4000 });
		expect(result.turns[0]!.text).toBe("abc…");
		expect(result.turns[0]!.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
	});
});
