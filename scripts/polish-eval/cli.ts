/**
 * Command line entry point for the transcript post-processing evaluation.
 *
 * Commands:
 *
 *   synth   --seeds <file> [--seed N] [--out <file>]
 *   script  --seeds <file> [--skeleton]
 *   ingest  --seeds <file> --raw <file> --backend <name> [--out <file>]
 *   run     --corpus <file> [options]
 *   compare --report <file.json> --against <file.json>
 *
 * The fake caller is the default so nothing leaves the machine and nothing costs
 * money until someone asks for it: a real round needs `--caller openai` plus a
 * base URL and model (options or the POLISH_EVAL_* environment variables), and it
 * is refused unless `--allow-network` is also passed.
 *
 * Usage: bun run scripts/polish-eval/cli.ts <command> [options]
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSyntheticCorpus, parseSeeds, renderReadingScript } from "./inject";
import type { CorpusSeed } from "./inject";
import { DEFAULT_CORPUS_PATH, loadCorpus, saveCorpus } from "./corpus";
import type { CorpusEntry } from "./corpus";
import { extractTranscript, NETWORK_ENV, openAiCompatibleCaller, resolveCaller } from "./callers";
import type { ResolvedCaller } from "./callers";
import { polishSamplingOptions, type PolishCaller } from "../../extensions/voice/post-process";
import { ARM_NAMES, renderMarkdownReport, runEvaluation } from "./runner";
import type { ArmName, RunResult } from "./runner";

interface Args {
	command: string;
	seeds: string;
	maxTokens?: number;
	reasoningEffort?: string;
	accepted?: string[];
	corpus: string;
	out?: string;
	raw?: string;
	backend?: string;
	seed: number;
	caller: string;
	arms: ArmName[];
	timeoutMs: number;
	turns: number;
	full: boolean;
	skeleton: boolean;
	allowNetwork: boolean;
	baseUrl?: string;
	model?: string;
	report?: string;
	against?: string;
}

function parseArgs(argv: readonly string[]): Args {
	const args: Args = {
		command: argv[0] ?? "help",
		seeds: path.join(fileURLToPath(new URL(".", import.meta.url)), "seeds.jsonl"),
		corpus: DEFAULT_CORPUS_PATH,
		seed: 1,
		caller: "fake",
		arms: [...ARM_NAMES],
		timeoutMs: 8000,
		turns: 2,
		full: false,
		skeleton: false,
		allowNetwork: false,
	};
	for (let index = 1; index < argv.length; index += 1) {
		const flag = argv[index];
		const next = () => argv[++index];
		if (flag === "--seeds") args.seeds = next() ?? args.seeds;
		else if (flag === "--corpus") args.corpus = next() ?? args.corpus;
		else if (flag === "--out") args.out = next();
		else if (flag === "--raw") args.raw = next();
		else if (flag === "--backend") args.backend = next();
		else if (flag === "--seed") args.seed = Number(next() ?? args.seed);
		else if (flag === "--caller") args.caller = next() ?? args.caller;
		else if (flag === "--arms") args.arms = (next() ?? "").split(",").filter(Boolean) as ArmName[];
		else if (flag === "--timeout-ms") args.timeoutMs = Number(next() ?? 8000);
		else if (flag === "--turns") args.turns = Number(next() ?? 2);
		else if (flag === "--base-url") args.baseUrl = next();
		else if (flag === "--model") args.model = next();
		else if (flag === "--report") args.report = next();
		else if (flag === "--against") args.against = next();
		else if (flag === "--full") args.full = true;
		else if (flag === "--skeleton") args.skeleton = true;
		else if (flag === "--allow-network") args.allowNetwork = true;
		else if (flag === "--max-tokens") args.maxTokens = Number(next() ?? 0);
		else if (flag === "--reasoning-effort") args.reasoningEffort = next();
		else if (flag === "--accepted") args.accepted = (next() ?? "").split(",").filter(Boolean);
	}
	return args;
}

const USAGE = [
	"Usage: bun run scripts/polish-eval/cli.ts <command> [options]",
	"",
	"  synth   --seeds <file> [--seed N] [--out <file>]   build a synthetic corpus",
	"  script  --seeds <file> [--skeleton]               print the script to read aloud,",
	"                                                    or a fill-in skeleton for a corpus",
	"  ingest  --seeds <file> --raw <file> --backend <name> [--out <file>]",
	"                                                    pair recorded transcripts with",
	"                                                    the seeds' ground truth",
	"  run     --corpus <file> [--caller fake|oracle|openai] [--arms a,b,c] [--out <dir>] [--full]",
	"          [--base-url URL] [--model NAME] [--allow-network] [--turns N] [--timeout-ms N] [--max-tokens N]",
	"          [--reasoning-effort none|auto] — auto mirrors the extension (thinking off only past",
	"                                                    the product's 200-character threshold)",
	"  compare --report <file.json> --against <file.json>",
	"",
	"A corpus lives outside the repository by default: " + DEFAULT_CORPUS_PATH,
].join("\n");

function readSeeds(filePath: string): CorpusSeed[] {
	const { seeds, errors } = parseSeeds(fs.readFileSync(filePath, "utf8"));
	if (errors.length > 0) {
		throw new Error(`seeds file has ${errors.length} problem(s):\n  ${errors.join("\n  ")}`);
	}
	return seeds;
}

/** Read a run report, reporting a readable problem instead of a raw parse error. */
function readRunResult(filePath: string): RunResult {
	let text: string;
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch (error) {
		throw new Error(`cannot read ${filePath}: ${error instanceof Error ? error.message : error}`);
	}
	try {
		return JSON.parse(text) as RunResult;
	} catch (error) {
		throw new Error(`${filePath} is not a run report: ${error instanceof Error ? error.message : error}`);
	}
}

/** One recording session's raw transcripts, keyed by seed id so they cannot drift. */
function readTranscripts(filePath: string): Map<string, string> {
	const transcripts = new Map<string, string>();
	const lines = fs.readFileSync(filePath, "utf8").split("\n");
	for (const [index, line] of lines.entries()) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		let parsed: { id?: unknown; raw?: unknown };
		try {
			parsed = JSON.parse(trimmed) as { id?: unknown; raw?: unknown };
		} catch (error) {
			throw new Error(
				`${filePath} line ${index + 1}: not valid JSON (${error instanceof Error ? error.message : error})`
			);
		}
		if (typeof parsed.id !== "string") throw new Error(`${filePath} line ${index + 1}: needs an id`);
		if (typeof parsed.raw !== "string") throw new Error(`${filePath} line ${index + 1}: needs a raw transcript`);
		transcripts.set(parsed.id, parsed.raw);
	}
	return transcripts;
}

/**
 * Pair a recording session with the seed sentences. Alignment is by id, never by
 * position: a corpus whose reference is off by one line would quietly measure
 * nonsense, so a missing or unknown id stops the import instead.
 */
function buildRecordedCorpus(
	seeds: readonly CorpusSeed[],
	transcripts: Map<string, string>,
	backend: string
): CorpusEntry[] {
	const missing = seeds.filter((seed) => !transcripts.has(seed.id)).map((seed) => seed.id);
	if (missing.length > 0) throw new Error(`no transcript recorded for: ${missing.join(", ")}`);
	const known = new Set(seeds.map((seed) => seed.id));
	const extra = [...transcripts.keys()].filter((id) => !known.has(id));
	if (extra.length > 0) throw new Error(`transcript for unknown seed id: ${extra.join(", ")}`);
	return seeds.map((seed) => {
		const context = seed.context?.map((text, position) => ({
			role: position % 2 === 0 ? ("user" as const) : ("assistant" as const),
			text,
		}));
		return {
			id: seed.id,
			category: seed.category,
			backend,
			raw: transcripts.get(seed.id) as string,
			groundTruth: seed.text,
			context,
			summary:
				seed.summary ??
				(context && context.length > 0 ? `Earlier: ${context.map((turn) => turn.text).join(" / ")}` : undefined),
		};
	});
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	if (args.command === "help" || args.command === "--help") {
		console.log(USAGE);
		return 0;
	}
	if (args.command === "script") {
		const seeds = readSeeds(args.seeds);
		if (args.skeleton) {
			// Fill in one `raw` per line after dictating the script once per backend.
			process.stdout.write(seeds.map((seed) => JSON.stringify({ id: seed.id, raw: "" })).join("\n") + "\n");
			return 0;
		}
		process.stdout.write(renderReadingScript(seeds));
		return 0;
	}
	if (args.command === "synth") {
		const corpus = buildSyntheticCorpus(readSeeds(args.seeds), { seed: args.seed });
		const out = args.out ?? path.join(os.homedir(), ".pi", "voicekit-eval", `synthetic-${args.seed}.jsonl`);
		saveCorpus(out, corpus);
		console.log(`wrote ${corpus.length} synthetic samples to ${out}`);
		return 0;
	}
	if (args.command === "ingest") {
		if (!args.raw) throw new Error('ingest needs --raw <file> (one {"id":...,"raw":...} per line)');
		if (!args.backend) throw new Error("ingest needs --backend <name> so the numbers stay per recogniser");
		const corpus = buildRecordedCorpus(readSeeds(args.seeds), readTranscripts(args.raw), args.backend);
		const out = args.out ?? path.join(os.homedir(), ".pi", "voicekit-eval", `${args.backend}-corpus.jsonl`);
		saveCorpus(out, corpus);
		console.log(`wrote ${corpus.length} recorded samples for the ${args.backend} backend to ${out}`);
		return 0;
	}
	if (args.command === "compare") {
		if (!args.report || !args.against) throw new Error("compare needs --report and --against");
		const first = readRunResult(args.report);
		const second = readRunResult(args.against);
		if (first.configurationHash !== second.configurationHash) {
			throw new Error(
				`refusing to compare: the configuration changed (${first.configurationHash} vs ${second.configurationHash}). ` +
					"Re-run the earlier configuration to get comparable numbers."
			);
		}
		const armA = first.arms.find((arm) => arm.arm === first.primaryArm);
		const armB = second.arms.find((arm) => arm.arm === second.primaryArm);
		console.log(`configuration hash matches (${first.configurationHash})`);
		console.log(`CER gain: ${armA?.meanCerGain.toFixed(3)} -> ${armB?.meanCerGain.toFixed(3)}`);
		console.log(
			`fallback: ${((armA?.fallbackRate ?? 0) * 100).toFixed(1)}% -> ${((armB?.fallbackRate ?? 0) * 100).toFixed(1)}%`
		);
		console.log(`flagged:  ${armA?.flagged} -> ${armB?.flagged}`);
		return 0;
	}
	if (args.command !== "run") {
		console.log(USAGE);
		return 2;
	}

	const entries =
		args.corpus === DEFAULT_CORPUS_PATH && !fs.existsSync(args.corpus)
			? (() => {
					throw new Error(
						`no corpus at ${args.corpus}. Build a synthetic one first:\n` +
							"  bun run scripts/polish-eval/cli.ts synth --out /tmp/corpus.jsonl"
					);
				})()
			: loadCorpus(args.corpus);

	// `oracle` answers with the corpus ground truth: it proves the pipeline can report a
	// perfect run, which is how the scorer's positive direction is checked end to end.
	// It is a self-check of the harness, never a measurement of the pass.
	const oracle: ResolvedCaller = {
		caller: async (request) => {
			const transcript = extractTranscript(request);
			const hit = entries.find((entry) => entry.raw === transcript);
			return { stopReason: "stop", content: [{ type: "text", text: hit?.groundTruth ?? transcript }] };
		},
		description: "oracle (answers with the corpus ground truth; a harness self-check)",
		modelRef: "oracle",
		usesNetwork: false,
	};
	const chosen =
		args.caller === "oracle"
			? oracle
			: resolveCaller(args.caller, {
					baseUrl: args.baseUrl,
					model: args.model,
					// What the extension sends to a reasoning model, so a measured run can match it.
					// "auto" is a mode, not an effort value: the wrapper below decides per request.
					...(args.reasoningEffort && args.reasoningEffort !== "auto"
						? { body: { reasoning_effort: args.reasoningEffort } }
						: {}),
				});
	if ("error" in chosen) throw new Error(chosen.error);
	const resolved = chosen;

	// A budget override, for measuring what the shipped formula costs on a model that thinks
	// before it answers. maxTokens is a cap, not a spend: the model stops when it is done.
	// `auto` mirrors what the extension sends: thinking on for a short dictation and off past the
	// product's threshold, because that is the configuration these numbers are meant to describe.
	const longCaller = (() => {
		const baseUrl = (args.baseUrl ?? process.env[NETWORK_ENV.baseUrl] ?? "").replace(/\/$/, "");
		const model = args.model ?? process.env[NETWORK_ENV.model];
		if (!baseUrl || !model) return undefined;
		return openAiCompatibleCaller({
			baseUrl,
			model,
			apiKey: process.env[NETWORK_ENV.apiKey],
			body: { reasoning_effort: "none" },
		});
	})();
	const selected: PolishCaller =
		args.reasoningEffort === "auto" && longCaller
			? (request, signal) =>
					polishSamplingOptions({ reasoning: true }, extractTranscript(request).length).samplingParams
						? longCaller(request, signal)
						: resolved.caller(request, signal)
			: resolved.caller;
	// A budget override, for measuring what the shipped formula costs on a model that thinks
	// before it answers. maxTokens is a cap, not a spend: the model stops when it is done.
	const caller: PolishCaller = args.maxTokens
		? (request, signal) => selected({ ...request, maxTokens: args.maxTokens ?? request.maxTokens }, signal)
		: selected;

	if (resolved.usesNetwork && !args.allowNetwork) {
		throw new Error(
			"refusing to call a model over the network without --allow-network (the run costs money and sends transcript text)"
		);
	}

	const run = await runEvaluation({
		entries,
		caller,
		accepted: args.accepted,
		callerDescription:
			resolved.description +
			(args.maxTokens ? ` maxTokens=${args.maxTokens}` : "") +
			(args.reasoningEffort ? ` reasoning_effort=${args.reasoningEffort}` : ""),
		modelRef: resolved.modelRef,
		arms: args.arms,
		limits: { turns: args.turns, perEntryChars: 500, totalChars: 4000 },
		timeoutMs: args.timeoutMs,
	});

	const outDir =
		args.out ?? path.join(os.homedir(), ".pi", "voicekit-eval", "runs", `${run.backend}-${run.configurationHash}`);
	fs.mkdirSync(outDir, { recursive: true });
	const reportPath = path.join(outDir, "report.md");
	const jsonPath = path.join(outDir, "run.json");
	fs.writeFileSync(reportPath, renderMarkdownReport(run, { full: args.full }), "utf8");
	fs.writeFileSync(jsonPath, JSON.stringify(run, null, 2) + "\n", "utf8");

	const primary = run.arms.find((arm) => arm.arm === run.primaryArm);
	console.log(`backend ${run.backend} | caller ${run.caller} | arm ${run.primaryArm} | hash ${run.configurationHash}`);
	console.log(
		`${primary?.count ?? 0} samples, ${primary?.applied ?? 0} applied, fallback ${((primary?.fallbackRate ?? 0) * 100).toFixed(1)}%, CER gain ${(primary?.meanCerGain ?? 0).toFixed(3)}, punct ${(primary?.meanPunctuationBefore ?? 0).toFixed(2)} -> ${(primary?.meanPunctuationAfter ?? 0).toFixed(2)}, flagged ${primary?.flagged ?? 0}`
	);
	for (const gate of run.gates) console.log(`  gate ${gate.id} ${gate.status.toUpperCase()}: ${gate.title}`);
	console.log(`report: ${reportPath}`);
	console.log(`json:   ${jsonPath}`);
	return run.gates.some((gate) => gate.status === "fail") ? 1 : 0;
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error: unknown) => {
		console.error(`polish-eval: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 2;
	});
