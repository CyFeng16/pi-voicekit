/**
 * The corpus: the (raw transcript, ground truth) pairs the evaluation scores.
 *
 * A corpus is JSON Lines so it can be produced by hand, by a script, or by a
 * recording session, and diffed line by line. It is deliberately NOT stored in
 * this repository: a corpus recorded from real dictation contains whatever the
 * speaker said. The default path lives outside the working tree.
 *
 * Spec: docs/superpowers/specs/2026-09-26-stt-post-processing-design.md (6)
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { EntryLike } from "../../extensions/voice/post-process-context";

/** A conversation entry the pass may see, in the shape the context module takes. */
export interface CorpusContextTurn {
	role: "user" | "assistant";
	text: string;
}

export interface CorpusEntry {
	id: string;
	category: string;
	/** Which recogniser produced `raw`. `synthetic` marks an injected sample. */
	backend: string;
	raw: string;
	/** What the speaker actually meant: the reference for every metric. */
	groundTruth: string;
	/** Optional conversation context for this dictation, oldest first. */
	context?: CorpusContextTurn[];
	/** Optional compaction summary the pass may see when the turn count is above zero. */
	summary?: string;
	note?: string;
}

export const DEFAULT_CORPUS_PATH = path.join(os.homedir(), ".pi", "voicekit-eval", "corpus.jsonl");

/** Conversation turns rendered as the entry shape the context assembler consumes. */
export function toEntryLikes(entry: CorpusEntry): EntryLike[] {
	const entries: EntryLike[] = [];
	if (entry.summary) entries.push({ type: "compaction", summary: entry.summary });
	for (const turn of entry.context ?? []) {
		entries.push({ type: "message", message: { role: turn.role, content: turn.text } });
	}
	return entries;
}

export interface ParseResult {
	entries: CorpusEntry[];
	errors: string[];
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/** Parse JSON Lines, reporting every problem instead of stopping at the first. */
export function parseCorpus(text: string): ParseResult {
	const entries: CorpusEntry[] = [];
	const errors: string[] = [];
	const seen = new Set<string>();
	const lines = text.split("\n");
	for (const [index, line] of lines.entries()) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch (error) {
			errors.push(`line ${index + 1}: not valid JSON (${error instanceof Error ? error.message : error})`);
			continue;
		}
		const candidate = parsed as Partial<CorpusEntry>;
		const problems: string[] = [];
		for (const field of ["id", "category", "backend", "raw", "groundTruth"] as const) {
			if (!isNonEmptyString(candidate[field])) problems.push(`missing ${field}`);
		}
		if (problems.length > 0) {
			errors.push(`line ${index + 1}: ${problems.join(", ")}`);
			continue;
		}
		const id = candidate.id as string;
		if (seen.has(id)) {
			errors.push(`line ${index + 1}: duplicate id ${id}`);
			continue;
		}
		seen.add(id);
		entries.push({
			id,
			category: candidate.category as string,
			backend: candidate.backend as string,
			raw: candidate.raw as string,
			groundTruth: candidate.groundTruth as string,
			context: Array.isArray(candidate.context) ? (candidate.context as CorpusContextTurn[]) : undefined,
			summary: isNonEmptyString(candidate.summary) ? candidate.summary : undefined,
			note: isNonEmptyString(candidate.note) ? candidate.note : undefined,
		});
	}
	return { entries, errors };
}

export function serializeCorpus(entries: readonly CorpusEntry[]): string {
	return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

export function loadCorpus(filePath: string): CorpusEntry[] {
	if (!fs.existsSync(filePath)) {
		throw new Error(`corpus not found: ${filePath} (build one with the synth command, or point --corpus at yours)`);
	}
	const { entries, errors } = parseCorpus(fs.readFileSync(filePath, "utf8"));
	if (errors.length > 0) {
		throw new Error(`corpus has ${errors.length} problem(s):\n  ${errors.join("\n  ")}`);
	}
	if (entries.length === 0) throw new Error(`corpus is empty: ${filePath}`);
	return entries;
}

export function saveCorpus(filePath: string, entries: readonly CorpusEntry[]): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, serializeCorpus(entries), "utf8");
}

/**
 * A run must never mix recognisers: the design record requires the protocol to be
 * run and reported per backend, never pooled, so pooling is refused here rather
 * than trusted to the caller.
 */
export function requireSingleBackend(entries: readonly CorpusEntry[]): string {
	const backends = [...new Set(entries.map((entry) => entry.backend))];
	if (backends.length === 0) throw new Error("corpus is empty");
	if (backends.length > 1) {
		throw new Error(
			`corpus mixes backends (${backends.join(", ")}); the protocol is reported per backend, never pooled`
		);
	}
	return backends[0] as string;
}
