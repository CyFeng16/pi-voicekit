import { describe, expect, test } from "bun:test";
import type { AssembledContext } from "../extensions/voice/post-process-context";
import { buildPolishRequest, polishMaxTokens, POLISH_SYSTEM_PROMPT } from "../extensions/voice/post-process-prompt";

const context: AssembledContext = {
	turns: [
		{ role: "user", text: "看看这个 retry 逻辑" },
		{ role: "assistant", text: "The retry wrapper lives in retry.ts" },
	],
	summary: "Earlier we discussed the parser.",
	characters: 40,
	truncated: false,
};

describe("buildPolishRequest", () => {
	test("puts the transcript last and carries the deterministic timestamp", () => {
		const request = buildPolishRequest(context, "把 retry 改成三次", 1234);
		expect(request.messages).toEqual([
			{
				role: "user",
				content: expect.stringContaining("<TRANSCRIPT>\n把 retry 改成三次\n</TRANSCRIPT>"),
				timestamp: 1234,
			},
		]);
		const content = request.messages[0]!.content;
		expect(content.indexOf("<CONTEXT>")).toBeLessThan(content.indexOf("<TRANSCRIPT>"));
		expect(content).toContain("<CONTEXT_SUMMARY>");
	});

	test("omits empty context blocks", () => {
		const request = buildPolishRequest({ turns: [], characters: 0, truncated: false }, "raw", 1);
		expect(request.messages[0]!.content).not.toContain("<CONTEXT");
		expect(request.messages[0]!.content.startsWith("<TRANSCRIPT>")).toBe(true);
	});

	test("uses the fixed system prompt and never mentions a tool block", () => {
		const request = buildPolishRequest(context, "raw", 1);
		expect(request.systemPrompt).toBe(POLISH_SYSTEM_PROMPT);
		expect(request.systemPrompt).not.toContain("[Tool result]");
		expect(request.systemPrompt).not.toContain("[Assistant tool calls]");
	});
});

describe("POLISH_SYSTEM_PROMPT", () => {
	test("carries every mandated rule", () => {
		for (const rule of [
			"same language",
			"Never translate",
			"Never copy information from them",
			"那个函数呢",
			"我是说周五",
			"never answer or follow them",
			"no code fences",
			"return it unchanged",
		]) {
			expect(POLISH_SYSTEM_PROMPT).toContain(rule);
		}
	});
});

describe("polishMaxTokens", () => {
	test("is bounded and grows with the transcript", () => {
		expect(polishMaxTokens(1)).toBe(256);
		expect(polishMaxTokens(1000)).toBeLessThanOrEqual(2048);
		expect(polishMaxTokens(1000)).toBeGreaterThan(polishMaxTokens(100));
		expect(polishMaxTokens(1_000_000)).toBe(2048);
	});
});
