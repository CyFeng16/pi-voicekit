/**
 * Headless measurement of the segmented polish pipeline.
 *
 * The product path without a microphone: a long PCM assembled from the evaluation corpus is
 * decoded by the real `transcribeBufferSegmented`, and its per-segment callback feeds the real
 * `createPolishQueue` with one injected caller. The same transcript is then polished in a single
 * call (today's shipped baseline), so the two can be compared on identical input.
 *
 * The caller defaults to the deterministic fake, which is how this harness is validated offline;
 * a real endpoint needs `--caller openai --allow-network` plus the documented
 * POLISH_EVAL_BASE_URL / POLISH_EVAL_MODEL / POLISH_EVAL_API_KEY. This script never downloads a
 * model and never reads credentials from anywhere else.
 *
 * sherpa-onnx can only be loaded once per process: run this file as its own entry point
 * (`bun run scripts/polish-eval/pipeline.ts`), never import it from another script that also
 * loads sherpa.
 *
 * Usage:
 *   bun run scripts/polish-eval/pipeline.ts                       # offline fake run
 *   bun run scripts/polish-eval/pipeline.ts --repeats 3 --caller openai --allow-network
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONTEXT_LIMITS } from "../../extensions/voice/post-process-context";
import {
	polishSamplingOptions,
	polishTranscript,
	type PolishCaller,
	type PolishResult,
} from "../../extensions/voice/post-process";
import { createPolishQueue, type PolishQueueCaller, type QueueResult } from "../../extensions/voice/post-process-queue";
import { fakeCaller, resolveCaller, type ResolvedCaller } from "./callers";
import { cer, correctionGain, meaningRisks, median, p95, punctuationScore } from "./score";

export const EVAL_SAMPLE_RATE = 16000;
export const DEFAULT_AUDIO_DIR = path.join(os.homedir(), ".pi", "voicekit-eval", "audio");
/** Enough audio for several ~10 s segments while keeping a repeated run cheap. */
export const DEFAULT_TARGET_SECONDS = 75;
/** `transcribeBufferSegmented`'s split point, in seconds of audio. */
export const SEGMENT_THRESHOLD_SECS = 10;

/** Raw 16-bit mono PCM at the evaluation rate: bytes -> seconds. */
export function pcmDurationSec(bytes: number): number {
	return bytes / 2 / EVAL_SAMPLE_RATE;
}

export interface LatencySummary {
	count: number;
	p50?: number;
	p95?: number;
	max?: number;
}

/** Nearest-rank p95 and the median, the same statistics the scorer reports. */
export function latencySummary(values: readonly number[]): LatencySummary {
	return {
		count: values.length,
		p50: median(values),
		p95: p95(values),
		max: values.length > 0 ? Math.max(...values) : undefined,
	};
}

export interface PipelineRun {
	/** Recognition start -> queue finish: what the user waits after releasing the key. */
	wallMs: number;
	/** Recognition start -> the recogniser returned: the decode itself. */
	recognitionMs: number;
	/** Recogniser returned -> queue finish: the polish still outstanding afterwards. */
	tailMs: number;
	/** Segment arrival offsets, ms after recognition started. */
	segmentArrivalMs: number[];
	result: QueueResult;
	rawTranscript: string;
	/** Each decoded piece in order, so a score can see where the segment seams landed. */
	pieceTexts: string[];
}

export interface BaselineRun {
	wallMs: number;
	status: PolishResult["status"];
	reason?: string;
}

export interface PipelineSummary {
	runs: number;
	wall: LatencySummary;
	recognition: LatencySummary;
	tail: LatencySummary;
	/** Wall p50 and p95 divided by the audio duration, so 1.0 means real time. */
	rtfxP50?: number;
	rtfxP95?: number;
	polished: number;
	failed: number;
	retried: number;
	fallbackRate: number;
	reasons: Record<string, number>;
	/** True when at least one run kept a polished neighbour while a segment fell back. */
	mixedOutcome: boolean;
	segmentLatency: LatencySummary;
}

/** Aggregate every run's queue outcome; the pipeline numbers the acceptance record asks for. */
export function summarizePipeline(runs: readonly PipelineRun[], durationSec: number): PipelineSummary {
	const wallMs: number[] = [];
	const recognitionMs: number[] = [];
	const tailMs: number[] = [];
	const segmentLatencyMs: number[] = [];
	let polished = 0;
	let failed = 0;
	let retried = 0;
	let mixedOutcome = false;
	const reasons: Record<string, number> = {};
	for (const run of runs) {
		wallMs.push(run.wallMs);
		recognitionMs.push(run.recognitionMs);
		tailMs.push(run.tailMs);
		polished += run.result.polished;
		failed += run.result.failed;
		retried += run.result.retried;
		if (run.result.polished > 0 && run.result.failed > 0) mixedOutcome = true;
		for (const segment of run.result.segments) {
			segmentLatencyMs.push(segment.latencyMs);
			if (segment.reason !== undefined) reasons[segment.reason] = (reasons[segment.reason] ?? 0) + 1;
		}
	}
	const wall = latencySummary(wallMs);
	const audioMs = durationSec * 1000;
	const total = polished + failed;
	return {
		runs: runs.length,
		wall,
		recognition: latencySummary(recognitionMs),
		tail: latencySummary(tailMs),
		rtfxP50: audioMs > 0 && wall.p50 !== undefined ? wall.p50 / audioMs : undefined,
		rtfxP95: audioMs > 0 && wall.p95 !== undefined ? wall.p95 / audioMs : undefined,
		polished,
		failed,
		retried,
		fallbackRate: total > 0 ? failed / total : 0,
		reasons,
		mixedOutcome,
		segmentLatency: latencySummary(segmentLatencyMs),
	};
}

export interface BaselineSummary {
	runs: number;
	wall: LatencySummary;
	applied: number;
	fallback: number;
	fallbackRate: number;
	reasons: Record<string, number>;
}

/** The single-call comparison: latency only over the runs whose pass applied. */
export function summarizeBaseline(runs: readonly BaselineRun[]): BaselineSummary {
	const applied = runs.filter((run) => run.status === "applied");
	const reasons: Record<string, number> = {};
	for (const run of runs) {
		if (run.reason !== undefined) reasons[run.reason] = (reasons[run.reason] ?? 0) + 1;
	}
	const fallback = runs.length - applied.length;
	return {
		runs: runs.length,
		wall: latencySummary(applied.map((run) => run.wallMs)),
		applied: applied.length,
		fallback,
		fallbackRate: runs.length > 0 ? fallback / runs.length : 0,
		reasons,
	};
}

function formatMs(value: number | undefined): string {
	return value === undefined ? "n/a" : `${Math.round(value)} ms`;
}

function formatPct(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function formatReasons(reasons: Record<string, number>): string {
	const entries = Object.entries(reasons).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
	return entries.length === 0 ? "none" : entries.map(([reason, count]) => `${reason} x${count}`).join(", ");
}

export interface PipelineQuality {
	/** Mean CER gain over runs: raw CER minus polished CER, so positive means the pass helped. */
	cerGain: number;
	punctuationBefore: number;
	punctuationAfter: number;
	/** CER of the raw transcript: how much this split damaged recognition itself. */
	rawCer: number;
	/** Punctuation marks in the reference, so an F1 of 0 against an unpunctuated corpus is readable. */
	referenceMarks: number;
}

function punctuationMarks(text: string): number {
	return (text.match(/[。！？!?.,，；;：:]/g) ?? []).length;
}

/** Score one run against the corpus reference: the quality half of the granularity comparison. */
export function scoreRunQuality(run: PipelineRun, groundTruth: string): PipelineQuality {
	const polished = run.result.text;
	const gain = correctionGain(run.rawTranscript, polished, groundTruth);
	const punctuation = punctuationScore(run.rawTranscript, polished, groundTruth);
	const risks = meaningRisks(run.rawTranscript, polished, groundTruth);
	const rawCer = cer(groundTruth, run.rawTranscript);
	const referenceMarks = punctuationMarks(groundTruth);
	return {
		cerGain: gain.cerGain,
		punctuationBefore: punctuation.before,
		punctuationAfter: punctuation.after,
		flagged: risks.any ? 1 : 0,
		rawCer,
		referenceMarks,
	};
}

export function summarizeQuality(values: readonly PipelineQuality[]): PipelineQuality | undefined {
	if (values.length === 0) return undefined;
	const mean = (pick: (value: PipelineQuality) => number): number =>
		values.reduce((sum, value) => sum + pick(value), 0) / values.length;
	return {
		cerGain: mean((value) => value.cerGain),
		punctuationBefore: mean((value) => value.punctuationBefore),
		punctuationAfter: mean((value) => value.punctuationAfter),
		flagged: values.reduce((sum, value) => sum + value.flagged, 0),
		rawCer: mean((value) => value.rawCer),
		referenceMarks: mean((value) => value.referenceMarks),
	};
}

export interface PipelineReportInput {
	durationSec: number;
	segmentsPerRun: number;
	localModel: string;
	callerDescription: string;
	pipeline: PipelineSummary;
	baseline: BaselineSummary;
	/** Quality against the corpus reference; omitted when the corpus carried no references. */
	quality?: PipelineQuality;
}

/** The compact report: pipeline first, then the single-call baseline, then the comparison. */
export function renderPipelineReport(input: PipelineReportInput): string {
	const { pipeline, baseline } = input;
	const pipelineP50 = pipeline.wall.p50;
	const baselineP50 = baseline.wall.p50;
	let comparison: string;
	if (pipelineP50 === undefined || baselineP50 === undefined) {
		comparison = "no comparable latency (no applied pass on one side)";
	} else if (pipelineP50 <= 0 || baselineP50 <= 0) {
		comparison = "no comparable latency (non-positive wall clock)";
	} else if (baselineP50 < 1) {
		// The fake caller answers instantly, so a ratio would be noise dressed as a speedup.
		comparison = "no comparable latency (baseline under 1 ms — fake caller returns instantly)";
	} else if (baselineP50 >= pipelineP50) {
		comparison = `${(baselineP50 / pipelineP50).toFixed(1)}x faster than the single call`;
	} else {
		comparison = `${(pipelineP50 / baselineP50).toFixed(1)}x slower than the single call`;
	}
	const fallbackDelta = (pipeline.fallbackRate - baseline.fallbackRate) * 100;
	const quality = input.quality;
	const qualityLine = quality
		? `quality:    raw CER ${quality.rawCer.toFixed(3)} -> polished ${(quality.rawCer - quality.cerGain).toFixed(3)} (gain ${quality.cerGain >= 0 ? "+" : ""}${quality.cerGain.toFixed(3)}) | punctuation ${quality.punctuationBefore.toFixed(2)} -> ${quality.punctuationAfter.toFixed(2)} (reference has ${quality.referenceMarks.toFixed(0)} marks) | meaning flags ${quality.flagged}`
		: "quality:    not scored (the corpus manifest carried no references)";
	return [
		`audio:      ${input.durationSec.toFixed(1)} s | ${input.segmentsPerRun} segments per run | recogniser ${input.localModel}`,
		`caller:     ${input.callerDescription}`,
		`pipeline:   ${pipeline.runs} run(s) | wall p50 ${formatMs(pipeline.wall.p50)} / p95 ${formatMs(pipeline.wall.p95)} | recognition p50 ${formatMs(pipeline.recognition.p50)} | tail p50 ${formatMs(pipeline.tail.p50)}`,
		`            RTFx p50 ${pipeline.rtfxP50 === undefined ? "n/a" : pipeline.rtfxP50.toFixed(3)}, p95 ${pipeline.rtfxP95 === undefined ? "n/a" : pipeline.rtfxP95.toFixed(3)} | segment latency p50 ${formatMs(pipeline.segmentLatency.p50)} / p95 ${formatMs(pipeline.segmentLatency.p95)}`,
		`segments:   polished ${pipeline.polished}, failed ${pipeline.failed}, retried ${pipeline.retried} | fallback ${formatPct(pipeline.fallbackRate)} | reasons ${formatReasons(pipeline.reasons)}`,
		`            mixed fallback (a failed segment beside a polished one): ${pipeline.mixedOutcome ? "yes" : "no"}`,
		`baseline:   ${baseline.runs} run(s) | wall p50 ${formatMs(baseline.wall.p50)} / p95 ${formatMs(baseline.wall.p95)} | fallback ${formatPct(baseline.fallbackRate)} | reasons ${formatReasons(baseline.reasons)}`,
		`comparison: pipeline is ${comparison}; fallback ${formatPct(baseline.fallbackRate)} -> ${formatPct(pipeline.fallbackRate)} (${fallbackDelta >= 0 ? "+" : "-"}${Math.abs(fallbackDelta).toFixed(1)} pts)`,
		qualityLine,
		"",
	].join("\n");
}

// ─── Audio corpus ────────────────────────────────────────────────────────────

export interface AudioCorpus {
	pcm: Buffer;
	durationSec: number;
	files: string[];
	/** True when no `.pcm` sat next to the wavs and ffmpeg produced the raw stream. */
	usedFfmpeg: boolean;
	/** Reference text per used file, in the same order, for scoring the concatenated audio. */
	references: string[];
	/** The references joined the way the audio ran, so a score can compare against the transcript. */
	groundTruth: string;
}

function walkFiles(root: string): string[] {
	const found: string[] = [];
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const full = path.join(root, entry.name);
		if (entry.isDirectory()) found.push(...walkFiles(full));
		else if (entry.isFile()) found.push(full);
	}
	return found;
}

function decodeWavWithFfmpeg(file: string): Buffer {
	const result = spawnSync(
		"ffmpeg",
		[
			"-nostdin",
			"-hide_banner",
			"-loglevel",
			"error",
			"-i",
			file,
			"-f",
			"s16le",
			"-ac",
			"1",
			"-ar",
			String(EVAL_SAMPLE_RATE),
			"pipe:1",
		],
		{ maxBuffer: 512 * 1024 * 1024 }
	);
	if (result.error) throw new Error(`ffmpeg is required to read ${file}: ${result.error.message}`);
	if (result.status !== 0) {
		throw new Error(`ffmpeg failed on ${file}: ${String(result.stderr).trim() || `exit ${result.status}`}`);
	}
	return result.stdout;
}

/** Key an audio file by name without its extension: the harness reads `.pcm`, the manifest lists `.wav`. */
function audioStem(file: string): string {
	return path.basename(file).replace(/\.(pcm|wav)$/i, "");
}

/** Reference text per audio file, keyed by basename, from the corpus manifest next to the audio. */
function loadReferences(audioDir: string): Map<string, string> {
	const manifest = path.join(path.dirname(audioDir), "corpora-manifest.jsonl");
	const references = new Map<string, string>();
	if (!fs.existsSync(manifest)) return references;
	for (const line of fs.readFileSync(manifest, "utf8").split("\n")) {
		if (!line.trim() || line.startsWith("#")) continue;
		try {
			const row = JSON.parse(line) as { audio?: string; reference?: string };
			if (row.audio && row.reference) {
				references.set(audioStem(row.audio), row.reference);
			}
		} catch {
			// A malformed manifest line must not sink the measurement.
		}
	}
	return references;
}

/** Join reference sentences like the audio ran: no space inside CJK, one space between latin runs. */
function joinReferences(parts: readonly string[]): string {
	let out = "";
	for (const part of parts) {
		const text = part.trim();
		if (!text) continue;
		if (!out) {
			out = text;
			continue;
		}
		const cjk = /[\u3000-\u9fff\uff00-\uffef]/;
		out += cjk.test(out.slice(-1)) && cjk.test(text[0] ?? "") ? text : ` ${text}`;
	}
	return out;
}

/**
 * Concatenate the evaluation corpus into one PCM, with a short gap between clips so the VAD sees a
 * natural pause there. `.pcm` files are already 16 kHz mono s16le; when only `.wav` files are
 * present, ffmpeg produces the raw stream instead of downloading or writing anything. Selection is
 * sorted and stops once the target duration is covered.
 */
export function buildPcm(audioDir: string, targetSeconds: number, gapMs = 350): AudioCorpus {
	if (!fs.existsSync(audioDir)) {
		throw new Error(`no evaluation audio at ${audioDir} — fetch the corpus first`);
	}
	const files = walkFiles(audioDir).sort();
	const pcmFiles = files.filter((file) => file.endsWith(".pcm"));
	const wavFiles = files.filter((file) => file.endsWith(".wav"));
	const sources = pcmFiles.length > 0 ? pcmFiles : wavFiles;
	if (sources.length === 0) throw new Error(`no .pcm or .wav files under ${audioDir}`);
	const usedFfmpeg = pcmFiles.length === 0;
	const references = loadReferences(audioDir);
	const chunks: Buffer[] = [];
	const used: string[] = [];
	const usedReferences: string[] = [];
	const gapBytes = Math.round((gapMs / 1000) * EVAL_SAMPLE_RATE) * 2;
	let bytes = 0;
	for (const file of sources) {
		if (pcmDurationSec(bytes) >= targetSeconds) break;
		const chunk = usedFfmpeg ? decodeWavWithFfmpeg(file) : fs.readFileSync(file);
		if (bytes > 0 && gapBytes > 0) {
			chunks.push(Buffer.alloc(gapBytes));
			bytes += gapBytes;
		}
		chunks.push(chunk);
		used.push(file);
		usedReferences.push(references.get(audioStem(file)) ?? "");
		bytes += chunk.length;
	}
	return {
		pcm: Buffer.concat(chunks),
		durationSec: pcmDurationSec(bytes),
		files: used,
		usedFfmpeg,
		references: usedReferences,
		groundTruth: joinReferences(usedReferences),
	};
}

// ─── Real recogniser, real queue, injected caller ────────────────────────────

interface RecogniserSetup {
	transcribe(pcm: Buffer, onSegment: (text: string, index: number) => void): Promise<string>;
	modelLabel: string;
}

interface SplitMode {
	mode: string;
	minSilenceSecs?: number;
	maxSpeechSecs?: number;
	mergeK?: number;
}

async function loadRecogniser(localModelId: string, language: string, split?: SplitMode): Promise<RecogniserSetup> {
	const {
		initSherpa,
		isSherpaAvailable,
		getSherpaError,
		getOrCreateRecognizer,
		decodeSegmentsInOrder,
		segmentPcmForLongAudio,
	} = await import("../../extensions/voice/sherpa-engine");
	const { DEFAULT_LOCAL_MODEL, LOCAL_MODELS } = await import("../../extensions/voice/local");
	const { getModelDir, isModelDownloaded } = await import("../../extensions/voice/model-download");
	if (!isSherpaAvailable()) {
		const ok = await initSherpa();
		if (!ok) throw new Error(`sherpa-onnx not available: ${getSherpaError() ?? "unknown error"}`);
	}
	const model =
		LOCAL_MODELS.find((entry) => entry.id === localModelId) ??
		LOCAL_MODELS.find((entry) => entry.id === DEFAULT_LOCAL_MODEL);
	if (!model) throw new Error(`unknown local model "${localModelId}"`);
	// Never download: this harness measures the pipeline, and a surprise fetch would both cost
	// time and make the run unrepeatable offline.
	if (!isModelDownloaded(model.id, model.sherpaModel.downloadUrls)) {
		throw new Error(
			`local model ${model.id} is not downloaded — install it from the settings panel first (this harness never downloads)`
		);
	}
	const recognizer = getOrCreateRecognizer(model, getModelDir(model.id), language);
	// The split mode is the experiment's only variable; everything downstream stays the product's own
	// decode loop, so a variant measures the product path with different boundaries.
	const toFloat32 = (buffer: Buffer): Float32Array => {
		const samples = new Float32Array(Math.floor(buffer.length / 2));
		for (let index = 0; index < samples.length; index += 1) {
			samples[index] = buffer.readInt16LE(index * 2) / 32768;
		}
		return samples;
	};
	const piecesFor = (pcm: Buffer): Float32Array[] => {
		const mode = split?.mode ?? "vad";
		if (mode === "whole") return [toFloat32(pcm)];
		if (mode.startsWith("fixed:")) {
			const secs = Number(mode.slice("fixed:".length)) || 10;
			const step = Math.max(1, Math.round(secs * EVAL_SAMPLE_RATE)) * 2;
			const pieces: Float32Array[] = [];
			for (let offset = 0; offset < pcm.length; offset += step) {
				pieces.push(toFloat32(pcm.subarray(offset, offset + step)));
			}
			return pieces;
		}
		const pieces = segmentPcmForLongAudio(
			toFloat32(pcm),
			EVAL_SAMPLE_RATE,
			split?.maxSpeechSecs ?? 10,
			split?.minSilenceSecs ?? 0.25
		);
		const k = Math.max(1, Math.floor(split?.mergeK ?? 1));
		if (k === 1) return pieces;
		const merged: Float32Array[] = [];
		for (let index = 0; index < pieces.length; index += k) {
			const group = pieces.slice(index, index + k);
			const total = group.reduce((sum, piece) => sum + piece.length, 0);
			const joined = new Float32Array(total);
			let cursor = 0;
			for (const piece of group) {
				joined.set(piece, cursor);
				cursor += piece.length;
			}
			merged.push(joined);
		}
		return merged;
	};
	return {
		modelLabel: model.id,
		transcribe: async (pcm, onSegment) =>
			(await decodeSegmentsInOrder(recognizer, piecesFor(pcm), onSegment)).join(" "),
	};
}

interface RunOptions {
	caller: PolishQueueCaller;
	timeoutMs: number;
	model: { reasoning?: boolean };
}

/**
 * One pipeline run: the real recogniser pushes each decoded segment into the real queue while
 * recognition continues, exactly as the handler does. Wall clock spans both.
 */
async function measurePipelineRun(pcm: Buffer, recogniser: RecogniserSetup, options: RunOptions): Promise<PipelineRun> {
	const arrivals: number[] = [];
	const pieceTexts: string[] = [];
	const queue = createPolishQueue({
		timeoutMs: options.timeoutMs,
		entries: [],
		limits: DEFAULT_CONTEXT_LIMITS,
		model: options.model,
		call: options.caller,
	});
	const start = performance.now();
	const rawTranscript = await recogniser.transcribe(pcm, (text, index) => {
		arrivals.push(performance.now() - start);
		pieceTexts.push(text);
		if (text.trim()) queue.push(index, text);
	});
	const recognitionMs = performance.now() - start;
	const result = await queue.finish();
	const wallMs = performance.now() - start;
	return {
		wallMs,
		recognitionMs,
		tailMs: wallMs - recognitionMs,
		segmentArrivalMs: arrivals,
		result,
		rawTranscript,
		pieceTexts,
	};
}

/** The shipped single-call baseline on the same transcript, with the same sampling gate. */
async function measureBaselineRun(raw: string, options: RunOptions): Promise<BaselineRun> {
	const sampling = polishSamplingOptions(options.model);
	const call: PolishCaller = (request, signal) => options.caller({ ...request, ...sampling }, signal);
	const start = performance.now();
	const result = await polishTranscript({
		raw,
		entries: [],
		limits: DEFAULT_CONTEXT_LIMITS,
		timeoutMs: options.timeoutMs,
		timestamp: Date.now(),
		call,
		isCurrent: () => true,
	});
	return { wallMs: performance.now() - start, status: result.status, reason: result.reason };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

interface PipelineArgs {
	audioDir: string;
	localModel: string;
	language: string;
	seconds: number;
	repeats: number;
	timeoutMs: number;
	caller: string;
	baseUrl?: string;
	model?: string;
	allowNetwork: boolean;
	fakeFail?: "timeout" | "error" | "rejected-status" | "empty";
	fakeSucceedFirst?: number;
	reasoning: boolean;
	out?: string;
	help: boolean;
	/** How the PCM is cut before decoding: vad (product default), vad+merge-k, fixed:<secs>, whole. */
	split: string;
	minSilence?: number;
	maxSpeech?: number;
	mergeK?: number;
	gapMs: number;
}

export function parseArgs(argv: readonly string[]): PipelineArgs {
	const args: PipelineArgs = {
		audioDir: DEFAULT_AUDIO_DIR,
		localModel: process.env.POLISH_EVAL_LOCAL_MODEL ?? "sensevoice-small",
		language: "auto",
		seconds: DEFAULT_TARGET_SECONDS,
		repeats: 1,
		timeoutMs: 8000,
		caller: "fake",
		allowNetwork: false,
		reasoning: true,
		help: false,
		split: "vad",
		gapMs: 350,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const next = (): string | undefined => argv[++index];
		if (flag === "--audio-dir") args.audioDir = next() ?? args.audioDir;
		else if (flag === "--local-model") args.localModel = next() ?? args.localModel;
		else if (flag === "--language") args.language = next() ?? args.language;
		else if (flag === "--seconds") args.seconds = Number(next() ?? args.seconds);
		else if (flag === "--repeats") args.repeats = Number(next() ?? args.repeats);
		else if (flag === "--timeout-ms") args.timeoutMs = Number(next() ?? args.timeoutMs);
		else if (flag === "--caller") args.caller = next() ?? args.caller;
		else if (flag === "--base-url") args.baseUrl = next();
		else if (flag === "--model") args.model = next();
		else if (flag === "--allow-network") args.allowNetwork = true;
		else if (flag === "--fake-fail") {
			const mode = next();
			if (mode) args.fakeFail = mode as PipelineArgs["fakeFail"];
		} else if (flag === "--fake-succeed-first") args.fakeSucceedFirst = Number(next() ?? 0);
		else if (flag === "--no-reasoning") args.reasoning = false;
		else if (flag === "--out") args.out = next();
		else if (flag === "--help" || flag === "-h") args.help = true;
		else if (flag === "--split") args.split = next() ?? args.split;
		else if (flag === "--min-silence") args.minSilence = Number(next() ?? 0.25);
		else if (flag === "--max-speech") args.maxSpeech = Number(next() ?? 10);
		else if (flag === "--merge-k") args.mergeK = Number(next() ?? 1);
		else if (flag === "--gap-ms") args.gapMs = Number(next() ?? args.gapMs);
	}
	return args;
}

const USAGE = [
	"Usage: bun run scripts/polish-eval/pipeline.ts [options]",
	"",
	"  --audio-dir <dir>          evaluation corpus audio (default: ~/.pi/voicekit-eval/audio)",
	"  --local-model <id>         sherpa model to recognise with (default: sensevoice-small,",
	"                             or POLISH_EVAL_LOCAL_MODEL)",
	"  --language <code>          recogniser language (default: auto)",
	"  --seconds <n>              audio to concatenate (default: 75)",
	"  --repeats <n>              full pipeline+baseline runs (default: 1)",
	"  --split <mode>             vad (default) | fixed:<secs> | whole; with vad also --merge-k <n>",
	"  --min-silence <secs>       pause length that ends a segment (default: 0.25, the shipped value)",
	"  --max-speech <secs>        hard cap on one segment (default: 10, the shipped value)",
	"  --merge-k <n>              glue n consecutive VAD pieces into one decode (default: 1)",
	"  --gap-ms <n>               silence inserted between corpus clips (default: 350)",
	"  --timeout-ms <n>           per-segment polish timeout (default: 8000)",
	"  --caller fake|openai       fake is deterministic and offline (default: fake)",
	"  --fake-fail <mode>         timeout|error|rejected-status|empty, to exercise fallbacks",
	"  --base-url/--model/--allow-network   real endpoint only (POLISH_EVAL_* env for the key)",
	"  --no-reasoning             the target model does not think before answering",
	"  --out <dir>                also write pipeline.json there",
	"",
	"Offline validation stays on the fake caller; a real round costs money and sends transcript",
	"text to the provider, so it needs --caller openai --allow-network.",
].join("\n");

function resolveFakeOrReal(args: PipelineArgs): ResolvedCaller {
	if (args.caller === "fake") {
		const failNote = args.fakeFail ? `; failing with ${args.fakeFail}` : "";
		return {
			caller: fakeCaller({ fail: args.fakeFail, succeedFirst: args.fakeSucceedFirst }),
			description: `deterministic fake (no network)${failNote}`,
			modelRef: "fake",
			usesNetwork: false,
		};
	}
	const resolved = resolveCaller(args.caller, { baseUrl: args.baseUrl, model: args.model });
	if ("error" in resolved) throw new Error(resolved.error);
	return resolved;
}

function runJson(input: {
	args: PipelineArgs;
	callerDescription: string;
	localModel: string;
	corpus: AudioCorpus;
	pipelineRuns: readonly PipelineRun[];
	baselineRuns: readonly BaselineRun[];
	summary: PipelineSummary;
	baseline: BaselineSummary;
}): string {
	return `${JSON.stringify(
		{
			durationSec: input.corpus.durationSec,
			audioFiles: input.corpus.files,
			builtWithFfmpeg: input.corpus.usedFfmpeg,
			localModel: input.localModel,
			caller: input.callerDescription,
			timeoutMs: input.args.timeoutMs,
			reasoning: input.args.reasoning,
			pipeline: {
				summary: input.summary,
				runs: input.pipelineRuns.map((run) => ({
					wallMs: run.wallMs,
					recognitionMs: run.recognitionMs,
					tailMs: run.tailMs,
					segmentArrivalMs: run.segmentArrivalMs,
					result: run.result,
					transcriptChars: run.rawTranscript.length,
				})),
			},
			baseline: { summary: input.baseline, runs: input.baselineRuns },
		},
		null,
		2
	)}\n`;
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(USAGE);
		return 0;
	}
	if (args.repeats < 1 || args.seconds <= 0 || args.timeoutMs <= 0) {
		throw new Error("--repeats, --seconds and --timeout-ms must be positive");
	}
	const resolved = resolveFakeOrReal(args);
	if (resolved.usesNetwork && !args.allowNetwork) {
		throw new Error(
			"refusing to call a model over the network without --allow-network (the run costs money and sends transcript text)"
		);
	}
	const corpus = buildPcm(args.audioDir, args.seconds, args.gapMs);
	console.log(
		`pcm:        ${corpus.files.length} file(s), ${corpus.durationSec.toFixed(1)} s${corpus.usedFfmpeg ? " (decoded with ffmpeg from wav)" : ""}`
	);
	if (corpus.durationSec < 60) console.log(`pcm:        warning: under 60 s of audio, fewer segments than intended`);
	const split: SplitMode = {
		mode: args.split,
		minSilenceSecs: args.minSilence,
		maxSpeechSecs: args.maxSpeech,
		mergeK: args.mergeK,
	};
	console.log(
		`split:      ${args.split}${args.mergeK ? ` merge-k=${args.mergeK}` : ""} min-silence=${args.minSilence ?? 0.25} max-speech=${args.maxSpeech ?? 10}`
	);
	const recogniser = await loadRecogniser(args.localModel, args.language, split);
	const caller: PolishQueueCaller = resolved.caller;
	const runOptions: RunOptions = { caller, timeoutMs: args.timeoutMs, model: { reasoning: args.reasoning } };
	const pipelineRuns: PipelineRun[] = [];
	const baselineRuns: BaselineRun[] = [];
	const qualities: PipelineQuality[] = [];
	for (let index = 0; index < args.repeats; index += 1) {
		const run = await measurePipelineRun(corpus.pcm, recogniser, runOptions);
		const baseline = await measureBaselineRun(run.rawTranscript, runOptions);
		qualities.push(scoreRunQuality(run, corpus.groundTruth));
		pipelineRuns.push(run);
		baselineRuns.push(baseline);
		console.log(
			`run ${index + 1}/${args.repeats}: pipeline wall ${Math.round(run.wallMs)} ms (recognise ${Math.round(run.recognitionMs)} ms, tail ${Math.round(run.tailMs)} ms) | baseline ${Math.round(baseline.wallMs)} ms ${baseline.status}`
		);
	}
	const summary = summarizePipeline(pipelineRuns, corpus.durationSec);
	const baseline = summarizeBaseline(baselineRuns);
	const report = renderPipelineReport({
		durationSec: corpus.durationSec,
		segmentsPerRun: pipelineRuns[0]?.result.segments.length ?? 0,
		localModel: recogniser.modelLabel,
		callerDescription: resolved.description,
		pipeline: summary,
		baseline,
		quality: summarizeQuality(qualities),
	});
	process.stdout.write(report);
	if (args.out) {
		fs.mkdirSync(args.out, { recursive: true });
		const jsonPath = path.join(args.out, "pipeline.json");
		fs.writeFileSync(
			jsonPath,
			runJson({
				args,
				callerDescription: resolved.description,
				localModel: recogniser.modelLabel,
				corpus,
				pipelineRuns,
				baselineRuns,
				summary,
				baseline,
			}),
			"utf8"
		);
		console.log(`json: ${jsonPath}`);
	}
	return 0;
}

// Keep the CLI inert when the tests import the pure helpers above. sherpa-onnx is native and
// can only load once per process, so the recogniser is imported lazily inside main anyway.
if (import.meta.main) {
	main()
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error: unknown) => {
			console.error(`polish-eval pipeline: ${error instanceof Error ? error.message : String(error)}`);
			process.exitCode = 2;
		});
}
