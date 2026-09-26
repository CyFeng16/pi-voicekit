import { describe, expect, test } from "bun:test";
import type { QueueResult, SegmentOutcome } from "../extensions/voice/post-process-queue";
import {
	latencySummary,
	pcmDurationSec,
	renderPipelineReport,
	summarizeBaseline,
	summarizePipeline,
	type BaselineRun,
	type PipelineRun,
} from "../scripts/polish-eval/pipeline";

function segment(index: number, status: "applied" | "fallback", reason?: string, retried = false): SegmentOutcome {
	const outcome: SegmentOutcome = { index, status, text: `segment ${index}`, retried, latencyMs: 100 * (index + 1) };
	if (reason !== undefined) outcome.reason = reason;
	return outcome;
}

function queueResult(segments: SegmentOutcome[]): QueueResult {
	return {
		text: segments.map((item) => item.text).join(" "),
		segments,
		polished: segments.filter((item) => item.status === "applied").length,
		failed: segments.filter((item) => item.status === "fallback").length,
		retried: segments.filter((item) => item.retried).length,
	};
}

function pipelineRun(overrides: Partial<PipelineRun> = {}): PipelineRun {
	const result = overrides.result ?? queueResult([segment(0, "applied"), segment(1, "applied")]);
	return {
		wallMs: 1000,
		recognitionMs: 600,
		tailMs: 400,
		segmentArrivalMs: [100, 200],
		rawTranscript: "raw transcript",
		result,
		...overrides,
	};
}

describe("pcmDurationSec", () => {
	test("reads 16 kHz mono s16le bytes as seconds", () => {
		expect(pcmDurationSec(32_000)).toBe(1);
		expect(pcmDurationSec(2 * 16_000 * 75)).toBe(75);
		expect(pcmDurationSec(0)).toBe(0);
	});
});

describe("latencySummary", () => {
	test("reports median, nearest-rank p95 and max", () => {
		expect(latencySummary([100, 200, 300, 400, 500])).toEqual({ count: 5, p50: 300, p95: 500, max: 500 });
		expect(latencySummary([10, 20, 30, 40])).toEqual({ count: 4, p50: 25, p95: 40, max: 40 });
	});

	test("an empty series has no latency at all", () => {
		expect(latencySummary([])).toEqual({ count: 0, p50: undefined, p95: undefined, max: undefined });
	});
});

describe("summarizePipeline", () => {
	test("sums the isolation accounting and reports the fallback rate", () => {
		const runs = [
			pipelineRun({
				result: queueResult([segment(0, "applied"), segment(1, "fallback", "timeout"), segment(2, "applied")]),
			}),
			pipelineRun({
				result: queueResult([segment(0, "applied"), segment(1, "fallback", "timeout"), segment(2, "applied")]),
			}),
		];
		const summary = summarizePipeline(runs, 75);
		expect(summary.runs).toBe(2);
		expect(summary.polished).toBe(4);
		expect(summary.failed).toBe(2);
		expect(summary.retried).toBe(0);
		expect(summary.fallbackRate).toBeCloseTo(2 / 6, 10);
		expect(summary.reasons).toEqual({ timeout: 2 });
		expect(summary.mixedOutcome).toBe(true);
		expect(summary.wall.p50).toBe(1000);
		expect(summary.segmentLatency.p50).toBe(200);
	});

	test("reports RTFx against the audio duration", () => {
		const summary = summarizePipeline([pipelineRun({ wallMs: 1500 })], 75);
		// 1500 ms of wall clock for 75 s of audio.
		expect(summary.rtfxP50).toBeCloseTo(1500 / 75_000, 10);
		expect(summary.rtfxP95).toBeCloseTo(1500 / 75_000, 10);
	});

	test("mixed fallback is false when every segment fell back", () => {
		const summary = summarizePipeline(
			[pipelineRun({ result: queueResult([segment(0, "fallback", "timeout"), segment(1, "fallback", "timeout")]) })],
			30
		);
		expect(summary.mixedOutcome).toBe(false);
		expect(summary.fallbackRate).toBe(1);
		expect(summary.reasons).toEqual({ timeout: 2 });
	});

	test("counts a retried segment once", () => {
		const summary = summarizePipeline(
			[pipelineRun({ result: queueResult([segment(0, "applied", undefined, true), segment(1, "applied")]) })],
			10
		);
		expect(summary.retried).toBe(1);
		expect(summary.polished).toBe(2);
		expect(summary.failed).toBe(0);
	});

	test("an empty run set stays defined instead of dividing by zero", () => {
		const summary = summarizePipeline([], 75);
		expect(summary.runs).toBe(0);
		expect(summary.fallbackRate).toBe(0);
		expect(summary.rtfxP50).toBeUndefined();
	});
});

describe("summarizeBaseline", () => {
	test("reports the single-call fallback rate over every run", () => {
		const runs: BaselineRun[] = [
			{ wallMs: 4000, status: "applied" },
			{ wallMs: 5000, status: "rejected", reason: "timeout" },
			{ wallMs: 4500, status: "applied" },
		];
		const summary = summarizeBaseline(runs);
		expect(summary.runs).toBe(3);
		expect(summary.applied).toBe(2);
		expect(summary.fallback).toBe(1);
		expect(summary.fallbackRate).toBeCloseTo(1 / 3, 10);
		// Latency only over the applied runs, exactly like the acceptance report.
		expect(summary.wall.p50).toBe(4250);
		expect(summary.reasons).toEqual({ timeout: 1 });
	});
});

describe("renderPipelineReport", () => {
	test("prints the pipeline, the baseline and the comparison between them", () => {
		const report = renderPipelineReport({
			durationSec: 75,
			segmentsPerRun: 3,
			localModel: "sensevoice-small",
			callerDescription: "deterministic fake (no network)",
			pipeline: summarizePipeline(
				[
					pipelineRun({
						result: queueResult([segment(0, "applied"), segment(1, "fallback", "timeout"), segment(2, "applied")]),
					}),
				],
				75
			),
			baseline: summarizeBaseline([{ wallMs: 4000, status: "applied" }]),
		});
		expect(report).toContain("75.0 s | 3 segments per run");
		expect(report).toContain("wall p50 1000 ms / p95 1000 ms");
		expect(report).toContain("RTFx p50 0.013");
		expect(report).toContain("polished 2, failed 1, retried 0");
		expect(report).toContain("fallback 33.3%");
		expect(report).toContain("mixed fallback (a failed segment beside a polished one): yes");
		expect(report).toContain("baseline:   1 run(s) | wall p50 4000 ms / p95 4000 ms");
		expect(report).toContain("fallback 0.0% -> 33.3% (+33.3 pts)");
		expect(report).toContain("comparison: pipeline is 4.0x faster than the single call");
	});

	test("an all-fallback baseline has no latency to compare against", () => {
		const report = renderPipelineReport({
			durationSec: 75,
			segmentsPerRun: 1,
			localModel: "sensevoice-small",
			callerDescription: "deterministic fake (no network)",
			pipeline: summarizePipeline([pipelineRun()], 75),
			baseline: summarizeBaseline([{ wallMs: 4000, status: "rejected", reason: "timeout" }]),
		});
		// A baseline that never applied must not look fast, and must not be reported as a speedup.
		expect(report).toContain("baseline:   1 run(s) | wall p50 n/a");
		expect(report).toContain("no comparable latency (no applied pass on one side)");
	});

	test("says a slower pipeline is slower instead of hiding it", () => {
		const report = renderPipelineReport({
			durationSec: 20,
			segmentsPerRun: 1,
			localModel: "sensevoice-small",
			callerDescription: "deterministic fake (no network)",
			pipeline: summarizePipeline([pipelineRun({ wallMs: 8000 })], 20),
			baseline: summarizeBaseline([{ wallMs: 4000, status: "applied" }]),
		});
		expect(report).toContain("comparison: pipeline is 2.0x slower than the single call");
	});

	test("does not dress a sub-millisecond fake baseline as a speedup", () => {
		const report = renderPipelineReport({
			durationSec: 75,
			segmentsPerRun: 2,
			localModel: "sensevoice-small",
			callerDescription: "deterministic fake (no network)",
			pipeline: summarizePipeline([pipelineRun()], 75),
			baseline: summarizeBaseline([
				{ wallMs: 0.05, status: "applied" },
				{ wallMs: 0.08, status: "applied" },
			]),
		});
		expect(report).toContain("no comparable latency (baseline under 1 ms");
	});
});
