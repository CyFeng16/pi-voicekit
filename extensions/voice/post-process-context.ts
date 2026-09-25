/**
 * Transcript post-processing: conversation-context assembly.
 *
 * Pure functions only — no Pi API, no I/O — so the whole module is testable
 * offline. The caller passes the compaction-aware projection returned by
 * `ctx.sessionManager.buildContextEntries()`, which is why `EntryLike` is
 * structural rather than imported: this package does not depend on pi-ai.
 *
 * Spec: docs/superpowers/specs/2026-09-26-stt-post-processing-design.md §4.3
 */

export interface EntryLike {
	type?: string;
	message?: { role?: string; content?: unknown };
	summary?: string;
}

export interface ContextLimits {
	/** User turns to keep, counted from the newest. 0 disables context entirely. */
	turns: number;
	/** Per-entry character cap, measured before rendering. */
	perEntryChars: number;
	/** Total character cap across turns and summary. */
	totalChars: number;
}

export interface ContextTurn {
	role: "user" | "assistant";
	text: string;
}

export interface AssembledContext {
	turns: ContextTurn[];
	summary?: string;
	/** Characters of extracted text, before rendering. */
	characters: number;
	/** True when a cap dropped or shortened something. */
	truncated: boolean;
}

export const DEFAULT_CONTEXT_LIMITS: ContextLimits = { turns: 2, perEntryChars: 500, totalChars: 4000 };

const ELLIPSIS = "…";

/** Extract only the text this feature is allowed to see from one entry's content. */
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as { type?: string; text?: string };
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

/** Keep the head of a long entry: terms are usually introduced early. */
function truncateHead(text: string, limit: number): { text: string; truncated: boolean } {
	const trimmed = text.trim();
	const capped = Math.max(1, limit);
	if (trimmed.length <= capped) return { text: trimmed, truncated: false };
	return { text: trimmed.slice(0, capped) + ELLIPSIS, truncated: true };
}

function toUnits(entries: readonly EntryLike[]): { units: ContextTurn[]; summary?: string } {
	const units: ContextTurn[] = [];
	let summary: string | undefined;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		if (entry.type === "compaction") {
			if (summary === undefined && typeof entry.summary === "string" && entry.summary.trim())
				summary = entry.summary.trim();
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = extractText(entry.message.content).trim();
		if (text) units.push({ role, text });
	}
	return { units, summary };
}

export function assembleContext(entries: readonly EntryLike[], limits: ContextLimits): AssembledContext {
	const { units, summary: rawSummary } = toUnits(entries);
	// turns = 0 means "no context at all", so the summary is out too — otherwise
	// the spec's contrast arm would not be context-free (Review Focus 5).
	const useSummary = limits.turns > 0 ? rawSummary : undefined;
	let truncated = false;

	let start = units.length;
	if (limits.turns > 0) {
		const userIndexes = units.map((unit, index) => (unit.role === "user" ? index : -1)).filter((index) => index >= 0);
		start = userIndexes.length > limits.turns ? userIndexes[userIndexes.length - limits.turns]! : 0;
	}

	let kept: ContextTurn[] = units.slice(start).map((unit) => {
		const capped = truncateHead(unit.text, limits.perEntryChars);
		truncated = truncated || capped.truncated;
		return { role: unit.role, text: capped.text };
	});

	let characters = kept.reduce((sum, unit) => sum + unit.text.length, 0);
	while (kept.length > 1 && characters > limits.totalChars) {
		characters -= kept[0]!.text.length;
		kept = kept.slice(1);
		truncated = true;
	}
	if (kept.length === 1 && characters > limits.totalChars) {
		const capped = truncateHead(kept[0]!.text, limits.totalChars);
		kept = [{ role: kept[0]!.role, text: capped.text }];
		characters = capped.text.length;
		truncated = true;
	}

	const summary = useSummary === undefined ? undefined : truncateHead(useSummary, limits.totalChars);
	if (summary?.truncated) truncated = true;

	return {
		turns: kept,
		summary: summary?.text,
		characters: characters + (summary?.text.length ?? 0),
		truncated,
	};
}
