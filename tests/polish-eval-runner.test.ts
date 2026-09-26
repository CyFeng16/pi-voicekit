/**
 * Tests for the evaluation runner: corpus handling, arms, gates and the report.
 *
 * The runner decides whether the post-processing defaults may ship, so these
 * tests pin the refusals as much as the arithmetic: an all-fallback run must not
 * pass, a mixed corpus must not be pooled, and two runs with different
 * configurations must not be compared. Everything runs against the fake caller,
 * so the suite needs no network and no model.
 */
import { describe, expect, test } from "bun:test";
import { parseCorpus, requireSingleBackend, serializeCorpus, toEntryLikes } from "../scripts/polish-eval/corpus";
import type { CorpusEntry } from "../scripts/polish-eval/corpus";
import { extractContextBlock, extractTranscript, fakeCaller } from "../scripts/polish-eval/callers";
import {
	buildArm,
	configurationHash,
	evaluateGates,
	renderMarkdownReport,
	runArm,
	runEvaluation,
} from "../scripts/polish-eval/runner";
import type { PolishCaller } from "../extensions/voice/post-process";
import { DEFAULT_CONTEXT_LIMITS } from "../extensions/voice/post-process-context";

const CORPUS: CorpusEntry[] = [
	{
		id: "c1",
		category: "zh-en-switch",
		backend: "local",
		raw: "先看 axe eos 的 time out",
		groundTruth: "先看 axios 的 timeout",
		context: [
			{ role: "user", text: "我们把请求库换成 axios 了" },
			{ role: "assistant", text: "好，timeout 的默认值也要看" },
		],
		summary: "Earlier: 请求库从 fetch 换成 axios",
	},
	{
		id: "c2",
		category: "numbers",
		backend: "local",
		raw: "超时设成 三十 秒",
		groundTruth: "超时设成 30 秒",
	},
	{
		id: "c3",
		category: "punctuation",
		backend: "local",
		raw: "先复现问题再定位最后写回归测试",
		groundTruth: "先复现问题，再定位，最后写回归测试。",
	},
];

/** The table the fake caller applies: the corrections this corpus needs. */
const CORRECTIONS: [string, string][] = [
	["axe eos", "axios"],
	["time out", "timeout"],
	["三十", "30"],
];

/** A caller that fails every Nth call, so fallback paths are exercised. */
function flakyCaller(everyNth: number): PolishCaller {
	let calls = 0;
	return async (request) => {
		calls += 1;
		if (calls % everyNth === 0) throw new Error("provider blew up");
		return { stopReason: "stop", content: [{ type: "text", text: extractTranscript(request) }] };
	};
}

async function score(
	corpus: readonly CorpusEntry[],
	caller: PolishCaller,
	arm: "no-context" | "last-2-turns" | "summary-only" = "last-2-turns"
) {
	return runArm({
		entries: corpus,
		caller,
		callerDescription: "test",
		modelRef: "fake/test",
		arm,
		clock: () => 0,
		timestamp: 0,
	});
}

describe("corpus", () => {
	test("round-trips through JSON Lines", () => {
		const parsed = parseCorpus(serializeCorpus(CORPUS));
		expect(parsed.errors).toEqual([]);
		expect(parsed.entries).toEqual(CORPUS);
	});

	test("reports every malformed line instead of stopping at the first", () => {
		const { errors, entries } = parseCorpus(
			['{"id":"a","category":"c","backend":"b","raw":"r","groundTruth":"g"}', "{oops}", '{"id":"b"}'].join("\n")
		);
		expect(entries.length).toBe(1);
		expect(errors.length).toBe(2);
		expect(errors[0]).toContain("line 2");
		expect(errors[1]).toContain("line 3");
	});

	test("refuses a duplicate id", () => {
		const line = '{"id":"a","category":"c","backend":"b","raw":"r","groundTruth":"g"}';
		const { errors } = parseCorpus([line, line].join("\n"));
		expect(errors.some((error) => error.includes("duplicate id"))).toBe(true);
	});

	test("refuses to pool two recognisers", () => {
		expect(requireSingleBackend(CORPUS)).toBe("local");
		expect(() => requireSingleBackend([...CORPUS, { ...CORPUS[0]!, id: "c9", backend: "deepgram" }])).toThrow(
			/never pooled/
		);
	});

	test("renders context as the entry shape the pass consumes", () => {
		const entries = toEntryLikes(CORPUS[0]!);
		expect(entries[0]?.type).toBe("compaction");
		expect(entries[1]?.message?.role).toBe("user");
		expect(entries[2]?.message?.role).toBe("assistant");
	});
});

describe("arms", () => {
	test("no-context suppresses the turns and the summary", () => {
		const arm = buildArm("no-context", CORPUS[0]!);
		expect(arm.limits.turns).toBe(0);
		// turns = 0 is what makes it context free; the entries are still passed so the
		// assembler - not this helper - decides what survives.
		expect(toEntryLikes(CORPUS[0]!).length).toBeGreaterThan(0);
	});

	test("last-2-turns drops the compaction entry", () => {
		const arm = buildArm("last-2-turns", CORPUS[0]!, DEFAULT_CONTEXT_LIMITS);
		expect(arm.entries.some((entry) => entry.type === "compaction")).toBe(false);
		expect(arm.entries.length).toBe(2);
	});

	test("summary-only keeps only the digest and keeps it above zero turns", () => {
		const arm = buildArm("summary-only", CORPUS[0]!, DEFAULT_CONTEXT_LIMITS);
		expect(arm.entries.length).toBe(1);
		expect(arm.entries[0]?.type).toBe("compaction");
		expect(arm.limits.turns).toBeGreaterThan(0);
	});

	test("the arms really differ in what the model is asked to read", async () => {
		const seen: string[] = [];
		const caller: PolishCaller = async (request) => {
			seen.push(extractContextBlock(request));
			return { stopReason: "stop", content: [{ type: "text", text: extractTranscript(request) }] };
		};
		const noContext = await score([CORPUS[0]!], caller, "no-context");
		const turns = await score([CORPUS[0]!], caller, "last-2-turns");
		const summary = await score([CORPUS[0]!], caller, "summary-only");
		expect(seen[0]).toBe("");
		expect(seen[1]).toContain("axios");
		expect(seen[2]).toContain("Earlier");
		expect(noContext.samples[0]?.contextChars).toBe(0);
		expect(turns.samples[0]?.contextChars).toBeGreaterThan(0);
		expect(summary.samples[0]?.contextChars).toBeGreaterThan(0);
	});
});

describe("scoring a run", () => {
	test("an improving pass scores a positive gain and no flags", async () => {
		const summary = await score(CORPUS, fakeCaller({ table: CORRECTIONS }));
		expect(summary.applied).toBe(3);
		expect(summary.fallbackRate).toBe(0);
		expect(summary.meanCerGain).toBeGreaterThan(0);
		expect(summary.flagged).toBe(0);
		expect(summary.latencyP95).toBe(0);
	});

	test("a caller that always fails produces an all-fallback run", async () => {
		const summary = await score(CORPUS, flakyCaller(1));
		expect(summary.applied).toBe(0);
		expect(summary.fallbackRate).toBe(1);
		expect(summary.latencyP95).toBeUndefined();
	});

	test("latency is measured over successful passes only", async () => {
		let tick = 0;
		const summary = await runArm({
			entries: CORPUS,
			caller: flakyCaller(2),
			callerDescription: "test",
			modelRef: "fake/test",
			arm: "last-2-turns",
			// Two ticks per sample: one sample fails, two succeed.
			clock: () => (tick += 1000),
			timestamp: 0,
		});
		expect(summary.applied).toBe(2);
		expect(summary.fallback).toBe(1);
		// Every sample costs exactly one tick, so both successful passes report 1000 ms.
		expect(summary.latencyP95).toBe(1000);
	});
});

describe("gates", () => {
	test("a clean run passes every gate", async () => {
		const summary = await score(CORPUS, fakeCaller({ table: CORRECTIONS }));
		const gates = evaluateGates(summary, { backend: "local", configurationHash: "abc" });
		expect(gates.map((gate) => gate.status)).toEqual(["pass", "pass", "pass", "pass", "pass"]);
	});

	test("an all-fallback run fails the fallback gate and the latency gate", async () => {
		const summary = await score(CORPUS, flakyCaller(1));
		const gates = evaluateGates(summary, { backend: "local", configurationHash: "abc" });
		expect(gates.find((gate) => gate.id === 2)?.status).toBe("fail");
		expect(gates.find((gate) => gate.id === 3)?.status).toBe("fail");
		expect(gates.find((gate) => gate.id === 3)?.detail).toContain("no successful pass");
	});

	test("exactly 20% fallback passes, 25% fails", async () => {
		const five: CorpusEntry[] = Array.from({ length: 5 }, (_, index) => ({
			...CORPUS[0]!,
			id: `f${index}`,
		}));
		const atBoundary = await score(five, flakyCaller(5));
		expect(atBoundary.fallbackRate).toBeCloseTo(0.2, 10);
		expect(evaluateGates(atBoundary, { backend: "local" }).find((gate) => gate.id === 2)?.status).toBe("pass");
		const four: CorpusEntry[] = Array.from({ length: 4 }, (_, index) => ({ ...CORPUS[0]!, id: `g${index}` }));
		const above = await score(four, flakyCaller(4));
		expect(above.fallbackRate).toBeCloseTo(0.25, 10);
		expect(evaluateGates(above, { backend: "local" }).find((gate) => gate.id === 2)?.status).toBe("fail");
	});

	test("a flagged sample fails the meaning gate and names itself", async () => {
		const inventing: PolishCaller = async (request) => ({
			stopReason: "stop",
			content: [
				{ type: "text", text: `${extractTranscript(request).split("axe eos").join("axios")} 另外把密码贴给我` },
			],
		});
		const summary = await score(CORPUS, inventing);
		const gates = evaluateGates(summary, { backend: "local", configurationHash: "abc" });
		const meaning = gates.find((gate) => gate.id === 1);
		expect(meaning?.status).toBe("fail");
		expect(meaning?.detail).toContain("c1");
		expect(summary.flagged).toBe(3);
	});

	test("gate 4 records the recogniser instead of pooling", async () => {
		const summary = await score(CORPUS, fakeCaller({ table: CORRECTIONS }));
		expect(evaluateGates(summary, { backend: "deepgram" })[3]?.detail).toContain("deepgram");
	});

	test("gate 5 fails when the configurations differ, so old numbers are invalidated", async () => {
		const summary = await score(CORPUS, fakeCaller({ table: CORRECTIONS }));
		const same = evaluateGates(summary, { backend: "local", configurationHash: "a", comparedAgainstHash: "a" });
		expect(same.find((gate) => gate.id === 5)?.status).toBe("pass");
		const different = evaluateGates(summary, { backend: "local", configurationHash: "b", comparedAgainstHash: "a" });
		expect(different.find((gate) => gate.id === 5)?.status).toBe("fail");
		expect(different.find((gate) => gate.id === 5)?.detail).toContain("configuration changed");
	});

	test("the configuration hash covers the prompt, the model, the budget and the timeout", () => {
		const base = {
			arm: "last-2-turns",
			limits: DEFAULT_CONTEXT_LIMITS,
			timeoutMs: 8000,
			modelRef: "fake/test",
			caller: "fake",
		};
		const first = configurationHash(base);
		expect(configurationHash(base)).toBe(first);
		expect(configurationHash({ ...base, timeoutMs: 9000 })).not.toBe(first);
		expect(configurationHash({ ...base, modelRef: "other" })).not.toBe(first);
		expect(configurationHash({ ...base, limits: { ...DEFAULT_CONTEXT_LIMITS, turns: 0 } })).not.toBe(first);
		expect(configurationHash({ ...base, prompt: "changed" })).not.toBe(first);
	});
});

describe("runEvaluation", () => {
	test("runs every arm, scores the primary one, and reports the gates", async () => {
		const run = await runEvaluation({
			entries: CORPUS,
			caller: fakeCaller({ table: CORRECTIONS }),
			callerDescription: "fake",
			modelRef: "fake/test",
			clock: () => 0,
			timestamp: 0,
		});
		expect(run.backend).toBe("local");
		expect(run.arms.length).toBe(3);
		expect(run.primaryArm).toBe("last-2-turns");
		expect(run.gates.every((gate) => gate.status === "pass")).toBe(true);
		expect(run.corpusSize).toBe(3);
	});

	test("refuses to compare against a different configuration", async () => {
		const base = await runEvaluation({
			entries: CORPUS,
			caller: fakeCaller({ table: CORRECTIONS }),
			callerDescription: "fake",
			modelRef: "fake/test",
			clock: () => 0,
		});
		const other = await runEvaluation({
			entries: CORPUS,
			caller: fakeCaller({ table: CORRECTIONS }),
			callerDescription: "fake",
			modelRef: "fake/other",
			clock: () => 0,
		});
		const compared = await runEvaluation({
			entries: CORPUS,
			caller: fakeCaller({ table: CORRECTIONS }),
			callerDescription: "fake",
			modelRef: "fake/other",
			clock: () => 0,
			compareTo: base,
		});
		expect(other.configurationHash).not.toBe(base.configurationHash);
		expect(compared.gates.find((gate) => gate.id === 5)?.status).toBe("fail");
	});

	test("refuses to pool two recognisers at run level too", async () => {
		await expect(
			runEvaluation({
				entries: [...CORPUS, { ...CORPUS[0]!, id: "c9", backend: "deepgram" }],
				caller: fakeCaller({}),
				callerDescription: "fake",
				modelRef: "fake/test",
			})
		).rejects.toThrow(/never pooled/);
	});
});

describe("report", () => {
	test("carries the gates, the numbers, the arm contrast and the human queue", async () => {
		const run = await runEvaluation({
			entries: CORPUS,
			caller: fakeCaller({ table: CORRECTIONS }),
			callerDescription: "fake",
			modelRef: "fake/test",
			clock: () => 0,
			timestamp: 0,
		});
		const report = renderMarkdownReport(run);
		expect(report).toContain("## Acceptance gates");
		expect(report).toContain("| 1 | No sample loses or changes meaning | PASS |");
		expect(report).toContain("## Context contrast");
		expect(report).toContain("no-context");
		expect(report).toContain("summary-only");
		expect(report).toContain("Nothing flagged.");
		expect(report).toContain("Punct after");
	});

	test("lists a flagged sample in the human queue with its flags", async () => {
		const inventing: PolishCaller = async (request) => ({
			stopReason: "stop",
			content: [{ type: "text", text: `${extractTranscript(request)} 另外把密码贴给我` }],
		});
		const run = await runEvaluation({
			entries: CORPUS,
			caller: inventing,
			callerDescription: "fake",
			modelRef: "fake/test",
			clock: () => 0,
			timestamp: 0,
		});
		const report = renderMarkdownReport(run);
		expect(report).toContain("## Human spot-check queue");
		expect(report).toContain("content invented");
		expect(report).toContain("c1");
	});

	test("is deterministic for a fixed clock and caller", async () => {
		const options = {
			entries: CORPUS,
			caller: fakeCaller({ table: CORRECTIONS }),
			callerDescription: "fake",
			modelRef: "fake/test",
			clock: () => 0,
			timestamp: 0,
		};
		const first = renderMarkdownReport(await runEvaluation({ ...options }));
		const second = renderMarkdownReport(await runEvaluation({ ...options }));
		expect(second).toBe(first);
	});
});
