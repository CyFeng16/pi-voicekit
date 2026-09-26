/**
 * The evaluation runner: arms, aggregation, gates and the report.
 *
 * One pass per sample per arm, timed, scored against the ground truth, and
 * aggregated into the numbers the design record's acceptance gates are written
 * in terms of. Three arms exist because the spec requires a three-way contrast
 * before conversation context ships: no context, the last N turns, and the
 * compaction summary alone.
 *
 * Two refusals are deliberate and enforced here rather than trusted to whoever
 * reads the output: a run never pools two recognisers, and two runs are only
 * comparable when their configuration hash matches - so a prompt or model change
 * invalidates the old numbers instead of silently mixing with them.
 *
 * Spec: docs/superpowers/specs/2026-09-26-stt-post-processing-design.md (4.3, 6)
 */
import { createHash } from "node:crypto";
import {
	DEFAULT_CONTEXT_LIMITS,
	type ContextLimits,
	type EntryLike,
} from "../../extensions/voice/post-process-context";
import { POLISH_SYSTEM_PROMPT } from "../../extensions/voice/post-process-prompt";
import { polishTranscript, type PolishCaller } from "../../extensions/voice/post-process";
import { requireSingleBackend, toEntryLikes, type CorpusEntry } from "./corpus";
import { median, p95, scoreSample, type SampleScore } from "./score";

export const ARM_NAMES = ["no-context", "last-2-turns", "summary-only"] as const;
export type ArmName = (typeof ARM_NAMES)[number];
export const PRIMARY_ARM: ArmName = "last-2-turns";

export interface ArmInput {
	entries: EntryLike[];
	limits: ContextLimits;
}

/** What each arm sends: no context at all, the last N turns, or only the digest. */
export function buildArm(name: ArmName, entry: CorpusEntry, base: ContextLimits = DEFAULT_CONTEXT_LIMITS): ArmInput {
	const likes = toEntryLikes(entry);
	if (name === "no-context") {
		// turns = 0 suppresses the summary too, so this arm is genuinely context-free.
		return { entries: likes, limits: { ...base, turns: 0 } };
	}
	if (name === "summary-only") {
		return {
			entries: likes.filter((item) => item.type === "compaction"),
			// Above zero, or the arm would drop the summary it exists to measure.
			limits: { ...base, turns: Math.max(1, base.turns) },
		};
	}
	return { entries: likes.filter((item) => item.type !== "compaction"), limits: { ...base } };
}

export interface RunOptions {
	entries: readonly CorpusEntry[];
	caller: PolishCaller;
	callerDescription: string;
	modelRef: string;
	arm?: ArmName;
	limits?: ContextLimits;
	timeoutMs?: number;
	/** Injectable clock so tests can assert a deterministic report. */
	clock?: () => number;
	/** Injectable time source for the pass's own timestamp parameter. */
	timestamp?: number;
}

export interface SampleResult extends SampleScore {
	arm: ArmName;
	truncatedContext: boolean;
}

export interface CategorySummary {
	category: string;
	samples: number;
	applied: number;
	meanCerGain: number;
	flagged: number;
}

export interface ArmSummary {
	arm: ArmName;
	samples: SampleResult[];
	count: number;
	applied: number;
	fallback: number;
	fallbackRate: number;
	meanCerBefore: number;
	meanCerAfter: number;
	meanCerGain: number;
	meanWerGain: number;
	meanPunctuationBefore: number;
	meanPunctuationAfter: number;
	falseEditRate: number;
	flagged: number;
	/** Latency over the samples whose pass was applied, and nothing else. */
	latencyP50?: number;
	latencyP95?: number;
	perCategory: CategorySummary[];
}

function mean(values: readonly number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarize(arm: ArmName, samples: readonly SampleResult[]): ArmSummary {
	const applied = samples.filter((sample) => sample.applied);
	const latencies = applied.map((sample) => sample.latencyMs);
	const categories = [...new Set(samples.map((sample) => sample.category))].sort();
	return {
		arm,
		samples: [...samples],
		count: samples.length,
		applied: applied.length,
		fallback: samples.length - applied.length,
		fallbackRate: samples.length === 0 ? 0 : (samples.length - applied.length) / samples.length,
		meanCerBefore: mean(applied.map((sample) => sample.gain.cerBefore)),
		meanCerAfter: mean(applied.map((sample) => sample.gain.cerAfter)),
		meanCerGain: mean(applied.map((sample) => sample.gain.cerGain)),
		meanWerGain: mean(applied.map((sample) => sample.gain.werGain)),
		meanPunctuationBefore: mean(applied.map((sample) => sample.punctuation.before)),
		meanPunctuationAfter: mean(applied.map((sample) => sample.punctuation.after)),
		falseEditRate: mean(applied.map((sample) => sample.edits.falseEditRate)),
		flagged: samples.filter((sample) => sample.safetyFlagged).length,
		latencyP50: median(latencies),
		latencyP95: p95(latencies),
		perCategory: categories.map((category) => {
			const bucket = samples.filter((sample) => sample.category === category);
			const bucketApplied = bucket.filter((sample) => sample.applied);
			return {
				category,
				samples: bucket.length,
				applied: bucketApplied.length,
				meanCerGain: mean(bucketApplied.map((sample) => sample.gain.cerGain)),
				flagged: bucket.filter((sample) => sample.safetyFlagged).length,
			};
		}),
	};
}

/** Run one arm over the whole corpus. */
export async function runArm(options: RunOptions & { arm: ArmName }): Promise<ArmSummary> {
	const clock = options.clock ?? (() => Date.now());
	const limits = options.limits ?? DEFAULT_CONTEXT_LIMITS;
	const timeoutMs = options.timeoutMs ?? 8000;
	const samples: SampleResult[] = [];
	for (const entry of options.entries) {
		const armInput = buildArm(options.arm, entry, limits);
		const started = clock();
		const result = await polishTranscript({
			raw: entry.raw,
			entries: armInput.entries,
			limits: armInput.limits,
			timeoutMs,
			timestamp: options.timestamp ?? 0,
			call: options.caller,
			isCurrent: () => true,
		});
		const latencyMs = clock() - started;
		samples.push({
			...scoreSample({
				id: entry.id,
				category: entry.category,
				backend: entry.backend,
				raw: entry.raw,
				polished: result.text,
				groundTruth: entry.groundTruth,
				status: result.status,
				reason: result.reason,
				latencyMs,
				contextChars: result.contextChars,
				arm: options.arm,
			}),
			arm: options.arm,
			truncatedContext: result.truncatedContext,
		});
	}
	return summarize(options.arm, samples);
}

export interface Gate {
	id: number;
	title: string;
	status: "pass" | "fail" | "n/a";
	detail: string;
}

/**
 * The five gates from the design record, evaluated for one arm. Gate 4 is
 * structural: `requireSingleBackend` has already refused a pooled corpus, so the
 * gate records which recogniser these numbers belong to.
 */
export function evaluateGates(
	summary: ArmSummary,
	options: { backend: string; configurationHash?: string; comparedAgainstHash?: string }
): Gate[] {
	const flagged = summary.samples.filter((sample) => sample.safetyFlagged);
	const gates: Gate[] = [
		{
			id: 1,
			title: "No sample loses or changes meaning",
			status: flagged.length === 0 ? "pass" : "fail",
			detail:
				flagged.length === 0
					? `no meaning flags across ${summary.count} samples`
					: `${flagged.length} sample(s) flagged: ${flagged
							.map((sample) => `${sample.id} (${flagList(sample)})`)
							.join(", ")}`,
		},
		{
			id: 2,
			title: "Fallback rate at most 20%",
			status: summary.count === 0 ? "n/a" : summary.fallbackRate <= 0.2 ? "pass" : "fail",
			detail:
				summary.count === 0
					? "no samples"
					: `${summary.fallback}/${summary.count} = ${(summary.fallbackRate * 100).toFixed(1)}% (any status other than applied counts as a fallback)`,
		},
		{
			id: 3,
			title: "p95 latency reported over successful passes only",
			status: summary.applied === 0 ? "fail" : "pass",
			detail:
				summary.applied === 0
					? "no successful pass, so no latency can be reported"
					: `p95 ${summary.latencyP95} ms / p50 ${summary.latencyP50} ms over ${summary.applied} applied pass(es); the fallback share is reported separately above`,
		},
		{
			id: 4,
			title: "Reported per backend, never pooled",
			status: "pass",
			detail: `all ${summary.count} samples come from the ${options.backend} backend; a run refuses a corpus that mixes backends`,
		},
		{
			id: 5,
			title: "Configuration recorded, so changed numbers are invalidated",
			status:
				options.comparedAgainstHash !== undefined &&
				options.configurationHash !== undefined &&
				options.comparedAgainstHash !== options.configurationHash
					? "fail"
					: "pass",
			detail:
				options.comparedAgainstHash !== undefined &&
				options.configurationHash !== undefined &&
				options.comparedAgainstHash !== options.configurationHash
					? `configuration changed (${options.configurationHash} vs ${options.comparedAgainstHash}): the earlier numbers do not describe this prompt, model or context budget`
					: `configuration hash ${options.configurationHash ?? "unrecorded"}`,
		},
	];
	return gates;
}

export function flagList(sample: SampleScore): string {
	const flags: string[] = [];
	if (sample.risks.numbersChanged) flags.push("number changed");
	if (sample.risks.identifiersChanged) flags.push("identifier changed");
	if (sample.risks.contentDropped) flags.push("content dropped");
	if (sample.risks.inventedContent) flags.push("content invented");
	return flags.length > 0 ? flags.join(", ") : "none";
}

export interface RunResult {
	backend: string;
	caller: string;
	modelRef: string;
	promptHash: string;
	configurationHash: string;
	arms: ArmSummary[];
	primaryArm: ArmName;
	gates: Gate[];
	corpusSize: number;
}

/** sha256 over everything that would make two runs incomparable. */
export function configurationHash(inputs: {
	arm: string;
	limits: ContextLimits;
	timeoutMs: number;
	modelRef: string;
	caller: string;
	prompt?: string;
}): string {
	const payload = JSON.stringify({
		arm: inputs.arm,
		turns: inputs.limits.turns,
		perEntryChars: inputs.limits.perEntryChars,
		totalChars: inputs.limits.totalChars,
		timeoutMs: inputs.timeoutMs,
		modelRef: inputs.modelRef,
		caller: inputs.caller,
		prompt: inputs.prompt ?? POLISH_SYSTEM_PROMPT,
	});
	return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export async function runEvaluation(
	options: RunOptions & { arms?: readonly ArmName[]; compareTo?: RunResult }
): Promise<RunResult> {
	const backend = requireSingleBackend(options.entries);
	const limits = options.limits ?? DEFAULT_CONTEXT_LIMITS;
	const timeoutMs = options.timeoutMs ?? 8000;
	const arms = options.arms && options.arms.length > 0 ? [...options.arms] : [...ARM_NAMES];
	const summaries: ArmSummary[] = [];
	for (const arm of arms) {
		summaries.push(await runArm({ ...options, arm }));
	}
	const primary = summaries.find((summary) => summary.arm === PRIMARY_ARM) ?? summaries[0];
	if (!primary) throw new Error("no arm ran");
	const hash = configurationHash({
		arm: primary.arm,
		limits,
		timeoutMs,
		modelRef: options.modelRef,
		caller: options.callerDescription,
	});
	return {
		backend,
		caller: options.callerDescription,
		modelRef: options.modelRef,
		promptHash: createHash("sha256").update(POLISH_SYSTEM_PROMPT).digest("hex").slice(0, 16),
		configurationHash: hash,
		arms: summaries,
		primaryArm: primary.arm,
		gates: evaluateGates(primary, {
			backend,
			configurationHash: hash,
			comparedAgainstHash: options.compareTo?.configurationHash,
		}),
		corpusSize: options.entries.length,
	};
}

function percent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function ms(value: number | undefined): string {
	return value === undefined ? "n/a" : `${Math.round(value)} ms`;
}

/** The markdown report: gates first, then the numbers, then the human queue. */
export function renderMarkdownReport(run: RunResult, options: { full?: boolean } = {}): string {
	const primary = run.arms.find((summary) => summary.arm === run.primaryArm);
	const lines: string[] = [
		"# Transcript post-processing evaluation",
		"",
		`- Backend: ${run.backend} (per backend; never pooled)`,
		`- Caller: ${run.caller}`,
		`- Model: ${run.modelRef}`,
		`- Primary arm: ${run.primaryArm}`,
		`- Corpus: ${run.corpusSize} samples`,
		`- Configuration hash: ${run.configurationHash}`,
		`- Prompt hash: ${run.promptHash}`,
		"",
		"## Acceptance gates",
		"",
		"| # | Gate | Status | Detail |",
		"| - | ---- | ------ | ------ |",
	];
	for (const gate of run.gates) {
		lines.push(`| ${gate.id} | ${gate.title} | ${gate.status.toUpperCase()} | ${gate.detail} |`);
	}
	lines.push(
		"",
		"## Numbers (primary arm)",
		"",
		"| Samples | Applied | Fallback | CER before | CER after | CER gain | WER gain | Punct before | Punct after | False edits | Flagged | p50 | p95 |",
		"| ------- | ------- | -------- | ---------- | --------- | -------- | -------- | ------------ | ----------- | ----------- | ------- | --- | --- |"
	);
	if (primary) {
		lines.push(
			`| ${primary.count} | ${primary.applied} | ${percent(primary.fallbackRate)} | ${primary.meanCerBefore.toFixed(3)} | ${primary.meanCerAfter.toFixed(3)} | ${primary.meanCerGain >= 0 ? "+" : ""}${primary.meanCerGain.toFixed(3)} | ${primary.meanWerGain >= 0 ? "+" : ""}${primary.meanWerGain.toFixed(3)} | ${primary.meanPunctuationBefore.toFixed(2)} | ${primary.meanPunctuationAfter.toFixed(2)} | ${percent(primary.falseEditRate)} | ${primary.flagged} | ${ms(primary.latencyP50)} | ${ms(primary.latencyP95)} |`
		);
	}
	lines.push("", "Gain is the reference error rate before minus after, over applied passes only.", "");
	lines.push(
		"## Per category",
		"",
		"| Category | Samples | Applied | CER gain | Flagged |",
		"| -------- | ------- | ------- | -------- | ------- |"
	);
	for (const category of primary?.perCategory ?? []) {
		lines.push(
			`| ${category.category} | ${category.samples} | ${category.applied} | ${category.meanCerGain >= 0 ? "+" : ""}${category.meanCerGain.toFixed(3)} | ${category.flagged} |`
		);
	}
	lines.push(
		"",
		"## Context contrast",
		"",
		"| Arm | Samples | CER gain | Fallback | Flagged | Context chars |",
		"| --- | ------- | -------- | -------- | ------- | ------------- |"
	);
	for (const summary of run.arms) {
		const contextChars = summary.samples.reduce((sum, sample) => sum + sample.contextChars, 0);
		lines.push(
			`| ${summary.arm} | ${summary.count} | ${summary.meanCerGain >= 0 ? "+" : ""}${summary.meanCerGain.toFixed(3)} | ${percent(summary.fallbackRate)} | ${summary.flagged} | ${contextChars} |`
		);
	}
	lines.push(
		"",
		"Context ships only if the context arms are gain-neutral or better against the no-context arm.",
		"",
		"## Human spot-check queue",
		""
	);
	const flagged = (primary?.samples ?? []).filter((sample) => sample.safetyFlagged);
	if (flagged.length === 0) lines.push("Nothing flagged.", "");
	else {
		lines.push(
			"| id | category | flags | raw | polished | reference |",
			"| -- | -------- | ----- | --- | -------- | --------- |"
		);
		for (const sample of flagged) {
			lines.push(
				`| ${sample.id} | ${sample.category} | ${flagList(sample)} | ${sample.raw} | ${sample.polished} | ${sample.groundTruth} |`
			);
		}
		lines.push("");
	}
	if (options.full) {
		lines.push(
			"## All samples",
			"",
			"| id | category | status | verdict | CER gain | flags | raw | polished |",
			"| -- | -------- | ------ | ------- | -------- | ----- | --- | -------- |"
		);
		for (const sample of primary?.samples ?? []) {
			lines.push(
				`| ${sample.id} | ${sample.category} | ${sample.status} | ${sample.verdict} | ${sample.gain.cerGain.toFixed(3)} | ${flagList(sample)} | ${sample.raw} | ${sample.polished} |`
			);
		}
		lines.push("");
	}
	return lines.join("\n");
}
