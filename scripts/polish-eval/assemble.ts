/**
 * Assemble long audios by randomly combining evaluation clips.
 *
 * Why this exists: a segmentation sweep needs many independent long audios, not one fixed
 * concatenation. Selection and gaps are seeded, so a re-run reproduces the same audios and two
 * sweeps stay comparable.
 *
 * Gaps vary *inside* one audio on purpose. A single fixed gap sits exactly on the pause thresholds
 * under test — a 350 ms gap is below 0.8 s but above 0.25 s, which made an earlier sweep's optimum
 * partly an artifact of the stitching. Randomised gaps spread across the thresholds instead.
 *
 * The output directory holds the assembled `.pcm` files and, one level up, a manifest whose
 * `reference` field is the concatenated reference text, which is what `pipeline.ts` scores against.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { audioStem, EVAL_SAMPLE_RATE, joinReferences } from "./pipeline";

export interface AssembleOptions {
	sourceDir: string;
	outDir: string;
	count: number;
	seed: number;
	minClips: number;
	maxClips: number;
	minSeconds: number;
	maxSeconds: number;
	minGapMs: number;
	maxGapMs: number;
	prefix: string;
}

export interface AssembledAudio {
	name: string;
	files: string[];
	durationSec: number;
	gapMs: number[];
	groundTruth: string;
}

const BYTES_PER_SECOND = EVAL_SAMPLE_RATE * 2;

/** mulberry32: small, seeded and stable across runs — the sweep's reproducibility depends on it. */
export function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function listClips(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listClips(full));
		else if (entry.isFile() && full.endsWith(".pcm")) out.push(full);
	}
	return out.sort();
}

/** Reference text per clip, keyed by stem, from the corpus manifest next to the clip directory. */
function loadSourceReferences(sourceDir: string): Map<string, string> {
	const manifest = path.join(path.dirname(sourceDir), "corpora-manifest.jsonl");
	const references = new Map<string, string>();
	if (!fs.existsSync(manifest)) return references;
	for (const line of fs.readFileSync(manifest, "utf8").split("\n")) {
		if (!line.trim() || line.startsWith("#")) continue;
		try {
			const row = JSON.parse(line) as { audio?: string; reference?: string };
			if (row.audio && row.reference) references.set(audioStem(row.audio), row.reference);
		} catch {
			// A malformed manifest line must not sink the assembly.
		}
	}
	return references;
}

export function assembleAudios(options: AssembleOptions): AssembledAudio[] {
	const clips = listClips(options.sourceDir);
	if (clips.length < options.minClips) {
		throw new Error(`need at least ${options.minClips} clips under ${options.sourceDir}`);
	}
	const references = loadSourceReferences(options.sourceDir);
	const random = seededRandom(options.seed);
	const pick = (min: number, max: number): number => min + Math.floor(random() * (max - min + 1));
	const span = (min: number, max: number): number => min + random() * (max - min);
	fs.mkdirSync(options.outDir, { recursive: true });
	const assembled: AssembledAudio[] = [];
	for (let index = 0; index < options.count; index += 1) {
		const wanted = pick(options.minClips, options.maxClips);
		const targetSeconds = span(options.minSeconds, options.maxSeconds);
		const chunks: Buffer[] = [];
		const used: string[] = [];
		const gapMs: number[] = [];
		let seconds = 0;
		// Sample without replacement: one long audio never repeats a clip, so its content is distinct.
		const pool = [...clips];
		while (used.length < wanted && pool.length > 0 && seconds < targetSeconds) {
			const chosen = pool.splice(Math.floor(random() * pool.length), 1)[0];
			if (!chosen) break;
			if (used.length > 0) {
				const gap = pick(options.minGapMs, options.maxGapMs);
				if (gap > 0) {
					chunks.push(Buffer.alloc(Math.round((gap / 1000) * BYTES_PER_SECOND)));
					seconds += gap / 1000;
					gapMs.push(gap);
				}
			}
			const chunk = fs.readFileSync(chosen);
			chunks.push(chunk);
			seconds += chunk.length / BYTES_PER_SECOND;
			used.push(chosen);
		}
		const name = `${options.prefix}-${String(index + 1).padStart(2, "0")}`;
		fs.writeFileSync(path.join(options.outDir, `${name}.pcm`), Buffer.concat(chunks));
		assembled.push({
			name,
			files: used,
			durationSec: seconds,
			gapMs,
			groundTruth: joinReferences(used.map((file) => references.get(audioStem(file)) ?? "")),
		});
	}
	return assembled;
}

function parseArgs(argv: readonly string[]): AssembleOptions {
	const options: AssembleOptions = {
		sourceDir: path.join(process.env.HOME ?? ".", ".pi", "voicekit-eval", "audio"),
		outDir: "/tmp/gran/audio",
		count: 12,
		seed: 1,
		minClips: 10,
		maxClips: 16,
		minSeconds: 60,
		maxSeconds: 95,
		minGapMs: 120,
		maxGapMs: 900,
		prefix: "mix",
	};
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const value = (): string | undefined => argv[++index];
		if (flag === "--source-dir") options.sourceDir = value() ?? options.sourceDir;
		else if (flag === "--out") options.outDir = value() ?? options.outDir;
		else if (flag === "--count") options.count = Number(value() ?? options.count);
		else if (flag === "--seed") options.seed = Number(value() ?? options.seed);
		else if (flag === "--min-clips") options.minClips = Number(value() ?? options.minClips);
		else if (flag === "--max-clips") options.maxClips = Number(value() ?? options.maxClips);
		else if (flag === "--min-seconds") options.minSeconds = Number(value() ?? options.minSeconds);
		else if (flag === "--max-seconds") options.maxSeconds = Number(value() ?? options.maxSeconds);
		else if (flag === "--min-gap-ms") options.minGapMs = Number(value() ?? options.minGapMs);
		else if (flag === "--max-gap-ms") options.maxGapMs = Number(value() ?? options.maxGapMs);
		else if (flag === "--prefix") options.prefix = value() ?? options.prefix;
	}
	return options;
}

/** Portable entry guard: runs under bun and node, and typechecks without bun-specific types. */
function isDirectRun(): boolean {
	const entry = process.argv[1];
	return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
	const options = parseArgs(process.argv.slice(2));
	const assembled = assembleAudios(options);
	// One manifest level up: that is where `pipeline.ts` looks for the references of an audio dir.
	const manifestPath = path.join(path.dirname(path.resolve(options.outDir)), "corpora-manifest.jsonl");
	fs.writeFileSync(
		manifestPath,
		assembled
			.map((audio) =>
				JSON.stringify({
					id: audio.name,
					corpus: "assembled",
					language: "mixed",
					duration: Number(audio.durationSec.toFixed(2)),
					audio: path.join(path.resolve(options.outDir), `${audio.name}.pcm`),
					reference: audio.groundTruth,
				})
			)
			.join("\n") + "\n",
		"utf8"
	);
	for (const audio of assembled) {
		const gaps = audio.gapMs;
		const meanGap = gaps.length === 0 ? 0 : Math.round(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length);
		console.log(
			`  ${audio.name}: ${audio.durationSec.toFixed(1)} s | ${audio.files.length} clips | gaps ${meanGap} ms mean (${gaps.length})`
		);
	}
	console.log(`manifest: ${manifestPath}`);
}
