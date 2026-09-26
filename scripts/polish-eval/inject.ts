/**
 * Synthetic ASR-error injection for the post-processing evaluation.
 *
 * The pass is text in, text out, so a corpus of (raw, ground truth) pairs is all
 * the evaluation needs - no microphone, no terminal, no audio. This module builds
 * such a pair from one clean sentence: it degrades the sentence the way a
 * recogniser does, keeping the clean text as the reference.
 *
 * Two properties are load-bearing:
 *
 * - Deterministic. The same seed always produces the same raw text, so two runs
 *   are comparable and a prompt change is the only reason a number moves.
 * - Never inventive. Every degradation comes from a table in this file, so a
 *   measured "gain" cannot come from the injector supplying wording the speaker
 *   never said. That property is asserted by a test.
 *
 * The tables are illustrative, not exhaustive: they exist to exercise the pass's
 * correction paths, and they are versioned with the tool so a corpus can be
 * reproduced later.
 *
 * Spec: docs/superpowers/specs/2026-09-26-stt-post-processing-design.md (6)
 */

export type InjectionKind = "punctuation" | "homophone" | "term-split" | "filler" | "number" | "drop";

export interface CorpusSeed {
	id: string;
	category: string;
	/** The clean sentence: what the speaker meant, and the ground truth for scoring. */
	text: string;
	/** Injection kinds to apply; omitted means the category default. */
	kinds?: InjectionKind[];
	note?: string;
	/** Prior conversation turns (oldest first) the pass may see as context. */
	context?: string[];
	/** A compaction digest, when the seed wants the summary arm to have something to send. */
	summary?: string;
}

import type { CorpusEntry } from "./corpus";

/** Re-exported so a caller of the injector needs only one import. */
export type { CorpusEntry };

/** Chinese homophone confusions a recogniser makes. */
const HOMOPHONES: [string, string][] = [
	["部署", "布署"],
	["端口", "段口"],
	["参数", "参素"],
	["重试", "重使"],
	["缓存", "缓村"],
	["线程", "线城"],
	["日志", "日制"],
	["编译", "便译"],
	["依赖", "衣赖"],
	["巡检", "寻检"],
];

/** English technical terms split phonetically. */
export const KNOWN_SPLITS: [string, string][] = [
	["axios", "axe eos"],
	["timeout", "time out"],
	["redis", "red iss"],
	["nginx", "engine X"],
	["postgres", "post gress"],
	["kubernetes", "cooper netties"],
	["docker", "darker"],
	["kafka", "cough ka"],
	["pipeline", "pipe line"],
	["webhook", "web hook"],
];

/** Fillers a recogniser transcribes faithfully because the speaker said them. */
export const KNOWN_FILLERS = ["嗯", "那个", "就是", "这个", "like", "you know"];

const SPOKEN_DIGITS: Record<string, string> = {
	"0": "零",
	"1": "一",
	"2": "二",
	"3": "三",
	"4": "四",
	"5": "五",
	"6": "六",
	"7": "七",
	"8": "八",
	"9": "九",
};

/** What each category exercises, unless the seed says otherwise. */
const KINDS_BY_CATEGORY: Record<string, InjectionKind[]> = {
	punctuation: ["punctuation"],
	"term-zh": ["homophone", "punctuation"],
	"zh-en-switch": ["term-split", "punctuation"],
	negation: ["punctuation", "drop"],
	numbers: ["number", "punctuation"],
	"paths-identifiers": ["term-split", "punctuation"],
	"topic-switch": ["punctuation"],
	fillers: ["filler", "punctuation"],
	"self-correction": ["punctuation", "drop"],
	adversarial: ["punctuation"],
};

/** mulberry32: small, fast, and identical across runs and machines. */
function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function pick<T>(items: readonly T[], random: () => number): T | undefined {
	if (items.length === 0) return undefined;
	return items[Math.floor(random() * items.length) % items.length];
}

function stripPunctuation(text: string): string {
	return text.replace(/[。，、！？；：（）《》【】“”‘’…—]/g, "").replace(/[.,;:!?]+$/g, "");
}

function applyHomophone(text: string, random: () => number): { text: string; applied: boolean } {
	const candidates = HOMOPHONES.filter(([right]) => text.includes(right));
	const chosen = pick(candidates, random);
	if (!chosen) return { text, applied: false };
	const [right, wrong] = chosen;
	return { text: text.replace(right, wrong), applied: true };
}

function applyTermSplit(text: string, random: () => number): { text: string; applied: boolean } {
	const candidates = KNOWN_SPLITS.filter(([right]) => text.toLowerCase().includes(right));
	const chosen = pick(candidates, random);
	if (!chosen) return { text, applied: false };
	const [right, wrong] = chosen;
	const at = text.toLowerCase().indexOf(right);
	if (at < 0) return { text, applied: false };
	return { text: text.slice(0, at) + wrong + text.slice(at + right.length), applied: true };
}

function applyFiller(text: string, random: () => number): { text: string; applied: boolean } {
	const filler = pick(KNOWN_FILLERS, random);
	if (!filler) return { text, applied: false };
	// A recogniser emits the filler where the speaker said it: at the start of the
	// utterance, or between clauses.
	const position = random() < 0.5 ? 0 : Math.max(0, Math.floor(text.length * random()));
	return { text: `${text.slice(0, position)}${filler}${text.slice(position)}`, applied: true };
}

function applyNumber(text: string, random: () => number): { text: string; applied: boolean } {
	const match = /\d{2,}/.exec(text);
	if (!match) return { text, applied: false };
	const digits = match[0];
	const spoken = Array.from(digits)
		.map((digit) => SPOKEN_DIGITS[digit] ?? digit)
		.join("");
	// Sometimes the digits are split apart instead of spoken.
	const replacement = random() < 0.5 ? spoken : Array.from(digits).join(" ");
	return { text: text.replace(digits, replacement), applied: true };
}

function applyDrop(text: string, random: () => number): { text: string; applied: boolean } {
	// Drop a short word from the middle: a recogniser losing a token, not a phrase.
	const words = text.split(" ").filter((word) => word.length > 0);
	if (words.length < 3) return { text, applied: false };
	const index = 1 + (Math.floor(random() * (words.length - 2)) % Math.max(1, words.length - 2));
	const dropped = words.filter((_, position) => position !== index);
	return { text: dropped.join(" "), applied: true };
}

/**
 * Degrade one clean sentence the way a recogniser would. Returns the degraded
 * text and the kinds that actually changed something, so a corpus can record why
 * a sample is hard.
 */
export function injectAsrErrors(
	clean: string,
	options: { seed?: number; kinds?: InjectionKind[] } = {}
): { raw: string; applied: InjectionKind[] } {
	const random = seededRandom(options.seed ?? 1);
	const kinds = options.kinds ?? ["punctuation", "term-split", "filler"];
	let text = clean;
	const applied: InjectionKind[] = [];
	for (const kind of kinds) {
		const before = text;
		if (kind === "punctuation") text = stripPunctuation(text);
		else if (kind === "homophone") text = applyHomophone(text, random).text;
		else if (kind === "term-split") text = applyTermSplit(text, random).text;
		else if (kind === "filler") text = applyFiller(text, random).text;
		else if (kind === "number") text = applyNumber(text, random).text;
		else if (kind === "drop") text = applyDrop(text, random).text;
		if (text !== before) applied.push(kind);
	}
	return { raw: text, applied };
}

/** Build a complete synthetic corpus: one degraded sample per seed. */
export function buildSyntheticCorpus(
	seeds: readonly CorpusSeed[],
	options: { seed?: number; backend?: string } = {}
): CorpusEntry[] {
	const baseSeed = options.seed ?? 1;
	return seeds.map((seed, index) => {
		const kinds = seed.kinds ?? KINDS_BY_CATEGORY[seed.category] ?? ["punctuation"];
		// Derive a per-entry seed so entries do not move together when the base moves.
		const { raw, applied } = injectAsrErrors(seed.text, { seed: baseSeed * 7919 + index * 104729, kinds });
		const context = seed.context?.map((text, position) => ({
			role: position % 2 === 0 ? ("user" as const) : ("assistant" as const),
			text,
		}));
		return {
			id: seed.id,
			category: seed.category,
			backend: options.backend ?? "synthetic",
			raw,
			groundTruth: seed.text,
			context,
			// The summary arm needs a digest to send. For a synthetic corpus it is
			// synthesised from the same turns the turns arm sees, and the report says so.
			summary:
				seed.summary ??
				(context && context.length > 0 ? `Earlier: ${context.map((turn) => turn.text).join(" / ")}` : undefined),
			note: seed.note ?? (applied.length > 0 ? `injected: ${applied.join(", ")}` : undefined),
		};
	});
}

/** Render the seeds as the script a human reads aloud when recording a real corpus. */
export function renderReadingScript(seeds: readonly CorpusSeed[]): string {
	const byCategory = new Map<string, CorpusSeed[]>();
	for (const seed of seeds) {
		const bucket = byCategory.get(seed.category) ?? [];
		bucket.push(seed);
		byCategory.set(seed.category, bucket);
	}
	const lines = [
		"# Reading script",
		"",
		"Read each line aloud once per backend, at a normal pace, without correcting",
		"yourself. The line is the ground truth; the transcript your recogniser",
		"produces is the raw input the pass will clean.",
		"",
	];
	for (const [category, bucket] of byCategory) {
		lines.push(`## ${category}`, "");
		for (const seed of bucket) lines.push(`- ${seed.id}: ${seed.text}`);
		lines.push("");
	}
	return lines.join("\n");
}

/**
 * Parse the seeds file: one JSON object per line. Lines that are blank or start
 * with a comment marker are ignored, so the file can carry its own explanation.
 */
export function parseSeeds(text: string): { seeds: CorpusSeed[]; errors: string[] } {
	const seeds: CorpusSeed[] = [];
	const errors: string[] = [];
	for (const [index, line] of text.split("\n").entries()) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("/") || trimmed.startsWith("*") || trimmed.startsWith("#")) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch (error) {
			errors.push(`line ${index + 1}: not valid JSON (${error instanceof Error ? error.message : error})`);
			continue;
		}
		const seed = parsed as Partial<CorpusSeed>;
		if (typeof seed.id !== "string" || typeof seed.category !== "string" || typeof seed.text !== "string") {
			errors.push(`line ${index + 1}: needs id, category and text`);
			continue;
		}
		seeds.push(seed as CorpusSeed);
	}
	return { seeds, errors };
}
