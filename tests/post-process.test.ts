import { describe, expect, test } from "bun:test";
import {
	decideApply,
	parseModelRef,
	polishTranscript,
	resolveModelChoice,
	validatePolishOutput,
	type AssistantLike,
	type PolishRequest,
} from "../extensions/voice/post-process";
import { DEFAULT_CONTEXT_LIMITS, type EntryLike } from "../extensions/voice/post-process-context";

const assistant = (text: string, overrides: Partial<AssistantLike> = {}): AssistantLike => ({
	stopReason: "stop",
	content: [{ type: "text", text }],
	...overrides,
});

const baseInput = {
	raw: "把 retry 改成 three 次",
	entries: [] as EntryLike[],
	limits: DEFAULT_CONTEXT_LIMITS,
	timeoutMs: 50,
	timestamp: 7,
};

describe("validatePolishOutput", () => {
	test("accepts a clean rewrite", () => {
		expect(validatePolishOutput(baseInput.raw, assistant("把 retry 改成三次"))).toEqual({
			accept: true,
			text: "把 retry 改成三次",
		});
	});

	test("rejects every non-stop termination", () => {
		for (const stopReason of ["error", "aborted", "length", "toolUse", "pending", "deferred", undefined]) {
			const verdict = validatePolishOutput(baseInput.raw, assistant("把 retry 改成三次", { stopReason }));
			expect(verdict.accept).toBe(false);
			expect(verdict.text).toBe(baseInput.raw);
		}
	});

	test("rejects an error message, a thinking-only body and an empty body", () => {
		expect(validatePolishOutput(baseInput.raw, assistant("x", { errorMessage: "boom" })).accept).toBe(false);
		expect(
			validatePolishOutput(baseInput.raw, { stopReason: "stop", content: [{ type: "thinking", thinking: "hmm" }] })
				.accept
		).toBe(false);
		expect(validatePolishOutput(baseInput.raw, assistant("   ")).accept).toBe(false);
	});

	test("rejects scaffolding echo and out-of-range rewrites", () => {
		expect(
			validatePolishOutput(baseInput.raw, assistant("<TRANSCRIPT>\n把 retry 改成三次\n</TRANSCRIPT>")).accept
		).toBe(false);
		expect(validatePolishOutput("x".repeat(100), assistant("too short")).accept).toBe(false);
		expect(validatePolishOutput("short", assistant("y".repeat(400))).accept).toBe(false);
	});

	test("rejects a scaffolding echo padded with a preamble (spec section 4.6 check 4)", () => {
		// Long enough that only the structural check can catch it: the ratio stays inside
		// [0.3, 2.0], and the text does not start with a tag.
		const raw = "x".repeat(100);
		const padded = `Here is the cleaned transcript:\n<TRANSCRIPT>\n${raw}\n</TRANSCRIPT>`;
		expect(validatePolishOutput(raw, assistant(padded))).toEqual({
			accept: false,
			text: raw,
			reason: "scaffolding-echo",
		});
	});

	test("accepts legitimate dictation that merely looks suspicious", () => {
		const raw = "explain the thinking behind this ``` fence and the </ tag";
		const polished = "Explain the thinking behind this ``` fence and the </ tag.";
		expect(validatePolishOutput(raw, assistant(polished)).accept).toBe(true);
	});
});

describe("parseModelRef", () => {
	test("treats an empty value and the literal session as the session model", () => {
		for (const value of [undefined, "", "session", "  session  "]) {
			expect(parseModelRef(value).kind).toBe("session");
		}
	});

	test("treats a malformed reference as invalid rather than as a session-model request", () => {
		for (const value of ["novalue", "/nope", "nope/"]) {
			expect(parseModelRef(value)).toEqual({ kind: "invalid", raw: value });
		}
	});

	test("splits an explicit reference on the first slash", () => {
		expect(parseModelRef("test-provider/test-model:max")).toEqual({
			kind: "explicit",
			provider: "test-provider",
			modelId: "test-model:max",
			raw: "test-provider/test-model:max",
		});
	});
});

describe("resolveModelChoice", () => {
	const sessionModel = { id: "session-model" };

	test("uses the session model for the session kind", () => {
		expect(resolveModelChoice(parseModelRef("session"), () => undefined, sessionModel)).toEqual({
			model: sessionModel,
			ref: "session",
		});
	});

	test("reports a missing session model instead of guessing", () => {
		expect(resolveModelChoice(parseModelRef("session"), () => undefined, undefined)).toEqual({
			ref: "session",
			reason: "no-session-model",
		});
	});

	test("returns the resolved explicit model", () => {
		const model = { id: "x" };
		expect(resolveModelChoice(parseModelRef("p/x"), () => ({ model, hasAuth: true }), sessionModel)).toEqual({
			model,
			ref: "p/x",
		});
	});

	test("splits a multi-slash reference on the first slash and resolves it through the lookup", () => {
		const parsed = parseModelRef("provider/anthropic/claude-x");
		expect(parsed).toEqual({
			kind: "explicit",
			provider: "provider",
			modelId: "anthropic/claude-x",
			raw: "provider/anthropic/claude-x",
		});
		const model = { id: "claude-x" };
		const seen: [string, string][] = [];
		expect(
			resolveModelChoice(
				parsed,
				(provider, modelId) => {
					seen.push([provider, modelId]);
					return { model, hasAuth: true };
				},
				undefined
			)
		).toEqual({ model, ref: "provider/anthropic/claude-x" });
		expect(seen).toEqual([["provider", "anthropic/claude-x"]]);
	});

	test("never falls back to the session model when the explicit one is unusable", () => {
		expect(resolveModelChoice(parseModelRef("p/x"), () => undefined, sessionModel)).toEqual({
			ref: "p/x",
			reason: "not-found",
		});
		expect(
			resolveModelChoice(parseModelRef("p/x"), () => ({ model: { id: "x" }, hasAuth: false }), sessionModel)
		).toEqual({
			ref: "p/x",
			reason: "no-auth",
		});
	});

	test("reports a malformed reference instead of using anything else", () => {
		expect(
			resolveModelChoice(parseModelRef("novalue"), () => ({ model: { id: "x" }, hasAuth: true }), sessionModel)
		).toEqual({
			ref: "novalue",
			reason: "malformed",
		});
	});
});

describe("decideApply", () => {
	test("applies only when the pass is current and the editor is untouched", () => {
		expect(decideApply({ tokenCurrent: true, editorSnapshot: "draft", currentEditor: "draft" })).toEqual({
			apply: true,
		});
		expect(decideApply({ tokenCurrent: false, editorSnapshot: "draft", currentEditor: "draft" }).apply).toBe(false);
		expect(decideApply({ tokenCurrent: true, editorSnapshot: "draft", currentEditor: "edited" })).toEqual({
			apply: false,
			reason: "editor-changed",
		});
	});
});

describe("polishTranscript", () => {
	test("returns the polished text on the happy path", async () => {
		const result = await polishTranscript({
			...baseInput,
			isCurrent: () => true,
			call: async () => assistant("把 retry 改成三次"),
		});
		expect(result.status).toBe("applied");
		expect(result.text).toBe("把 retry 改成三次");
	});

	test("keeps the raw text when the caller throws", async () => {
		const result = await polishTranscript({
			...baseInput,
			call: async () => {
				throw new Error("provider down");
			},
		});
		expect(result).toEqual({
			status: "rejected",
			text: baseInput.raw,
			reason: "call-failed",
			contextChars: 0,
			truncatedContext: false,
		});
	});

	test("stays fail-open when the debug hook throws in the failure path", async () => {
		const result = await polishTranscript({
			...baseInput,
			debug: () => {
				throw new Error("debug exploded");
			},
			call: async () => {
				throw new Error("provider down");
			},
		});
		expect(result).toEqual({
			status: "rejected",
			text: baseInput.raw,
			reason: "call-failed",
			contextChars: 0,
			truncatedContext: false,
		});
	});

	test("times out, aborts the request and keeps the raw text", async () => {
		let aborted = false;
		const result = await polishTranscript({
			...baseInput,
			call: (_request: PolishRequest, signal: AbortSignal) =>
				new Promise<AssistantLike>((_, reject) => {
					signal.addEventListener("abort", () => {
						aborted = true;
						reject(new Error("aborted"));
					});
				}),
		});
		expect(aborted).toBe(true);
		expect(result.status).toBe("rejected");
		expect(result.reason).toBe("timeout");
		expect(result.text).toBe(baseInput.raw);
	});

	test("discards a result that arrived after invalidation", async () => {
		const result = await polishTranscript({
			...baseInput,
			isCurrent: () => false,
			call: async () => assistant("把 retry 改成三次"),
		});
		expect(result).toEqual({
			status: "skipped",
			text: baseInput.raw,
			reason: "invalidated",
			contextChars: 0,
			truncatedContext: false,
		});
	});

	test("reports the assembled context size", async () => {
		const entries: EntryLike[] = [{ type: "message", message: { role: "user", content: "你好" } }];
		const result = await polishTranscript({
			...baseInput,
			entries,
			call: async (request) => {
				expect(request.messages[0]!.content).toContain("[user] 你好");
				return assistant("把 retry 改成三次");
			},
		});
		expect(result.contextChars).toBe(2);
	});
});
