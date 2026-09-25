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

	test("includes the compaction summary as its own field", () => {
		const entries: EntryLike[] = [
			{ type: "compaction", summary: "earlier: we set up the parser" },
			msg("user", "carry on"),
		];
		const result = assembleContext(entries, limits);
		expect(result.summary).toBe("earlier: we set up the parser");
		expect(result.turns.map((t) => t.text)).toEqual(["carry on"]);
	});

	test("turns = 0 yields no context at all, summary included", () => {
		const entries: EntryLike[] = [{ type: "compaction", summary: "earlier" }, msg("user", "a"), msg("assistant", "b")];
		const result = assembleContext(entries, { ...limits, turns: 0 });
		expect(result.turns).toEqual([]);
		expect(result.summary).toBeUndefined();
		expect(result.characters).toBe(0);
	});

	test("truncates a long entry from the head and flags it", () => {
		const long = "x".repeat(50);
		const result = assembleContext([msg("user", long)], { turns: 1, perEntryChars: 10, totalChars: 4000 });
		expect(result.turns[0]!.text).toBe("xxxxxxxxxx…");
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
});
