/**
 * Transcript post-processing: conversation-context assembly.
 *
 * Pure functions only — no Pi API, no I/O — so the whole module is testable
 * offline. The caller passes the compaction-aware projection returned by
 * `ctx.sessionManager.buildContextEntries()`, which is why `EntryLike` is
 * structural rather than imported: this package does not depend on pi-ai.
 *
 * Spec: docs/superpowers/specs/2026-09-26-stt-post-processing-design.md §4.3
 * (a local design record, not part of the published package)
 */

export interface EntryLike {
	type?: string;
	message?: { role?: string; content?: unknown };
	summary?: string;
}

export interface ContextLimits {
	/** User turns to keep, counted from the newest. 0 disables context entirely. */
	turns: number;
	/** Per-entry character cap on the text as returned, elision marker included. */
	perEntryChars: number;
	/** Total character cap across the turns that are kept. */
	totalChars: number;
}

export interface ContextTurn {
	role: "user" | "assistant";
	text: string;
}

export interface AssembledContext {
	turns: ContextTurn[];
	/** Characters of the text as returned, elision markers included; never above totalChars. */
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
	const cap = Math.floor(limit);
	if (cap <= 0) return { text: "", truncated: trimmed.length > 0 };
	if (trimmed.length <= cap) return { text: trimmed, truncated: false };
	// R11: the elision marker is part of the cap, so cut one code unit short of it.
	let cut = cap - 1;
	// R12: never end the kept text on a high surrogate — a split pair reaches the
	// prompt as U+FFFD once the text is encoded to UTF-8.
	if (cut > 0 && isHighSurrogate(trimmed.charCodeAt(cut - 1))) cut -= 1;
	return { text: trimmed.slice(0, cut) + ELLIPSIS, truncated: true };
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

/**
 * R10: floor and clamp the turn limit locally. A non-integer value would produce
 * a fractional slice index, and `slice(undefined)` means `slice(0)` — the limit
 * would silently vanish and the whole history would be kept. Non-finite input is
 * malformed and fails closed to no context.
 */
function resolveTurns(turns: number): number {
	return Number.isFinite(turns) ? Math.max(0, Math.floor(turns)) : 0;
}

function toUnits(entries: readonly EntryLike[]): ContextTurn[] {
	const units: ContextTurn[] = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		if (entry.type === "compaction") {
			// A compaction entry is skipped outright: the digest it carries can hold residues
			// of thinking and tool output, and it measured no gain over the turns alone.
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = extractText(entry.message.content).trim();
		// Item 7: a user message always opens a turn — an image-only one consumes a turn
		// even though it contributes no text. Assistant text with nothing in it
		// contributes nothing at all.
		if (role === "user" || text) units.push({ role, text });
	}
	return units;
}

/** A turn is one user entry plus every following non-user entry (spec §4.3 item 3). */
function groupTurns(units: readonly ContextTurn[]): ContextTurn[][] {
	const turns: ContextTurn[][] = [];
	for (const unit of units) {
		if (unit.role === "user" || turns.length === 0) turns.push([]);
		turns[turns.length - 1]!.push(unit);
	}
	return turns;
}

function turnSize(turn: readonly ContextTurn[]): number {
	return turn.reduce((sum, entry) => sum + entry.text.length, 0);
}

/**
 * R9: the newest turn is never dropped. When it alone exceeds the budget, keep
 * its head — entries in order, the first one (the user entry) included — and
 * elide the tail so the total still fits.
 */
function fitTurnToBudget(turn: readonly ContextTurn[], budget: number): ContextTurn[] {
	const fitted: ContextTurn[] = [];
	let remaining = budget;
	for (const entry of turn) {
		// Under one character left, nothing usable fits — an empty entry is not kept.
		if (remaining < 1) break;
		const capped = truncateHead(entry.text, remaining);
		fitted.push({ role: entry.role, text: capped.text });
		remaining -= capped.text.length;
		if (capped.truncated) break;
	}
	return fitted;
}

export function assembleContext(entries: readonly EntryLike[], limits: ContextLimits): AssembledContext {
	const units = toUnits(entries);
	// R10: resolve the turn limit once, locally — see resolveTurns.
	const turns = resolveTurns(limits.turns);
	let truncated = false;

	let start = units.length;
	if (turns > 0) {
		const userIndexes = units.map((unit, index) => (unit.role === "user" ? index : -1)).filter((index) => index >= 0);
		start = userIndexes.length > turns ? userIndexes[userIndexes.length - turns]! : 0;
	}

	const selected = units.slice(start).map((unit) => {
		const capped = truncateHead(unit.text, limits.perEntryChars);
		truncated = truncated || capped.truncated;
		return { role: unit.role, text: capped.text };
	});

	// R8 + R9: one shared budget, spent on whole turns from the oldest first.
	// Dropping single entries could keep an assistant reply whose user entry is
	// gone, which is not a turn (spec §4.3 item 3). Item 7: grouping is also what
	// counts the turns, so it happens before the empty entries are dropped — inside
	// a turn only the sendable text reaches the prompt.
	const groups = groupTurns(selected).map((turn) => turn.filter((unit) => unit.text));
	const sizes = groups.map(turnSize);
	let first = 0;
	let characters = sizes.reduce((sum, size) => sum + size, 0);
	while (groups.length - first > 1 && characters > limits.totalChars) {
		characters -= sizes[first]!;
		first += 1;
		truncated = true;
	}
	let keptTurns = groups.slice(first);
	if (keptTurns.length === 1 && characters > limits.totalChars) {
		keptTurns = [fitTurnToBudget(keptTurns[0]!, limits.totalChars)];
		characters = turnSize(keptTurns[0]!);
		truncated = true;
	}
	const kept = keptTurns.flat();

	return {
		turns: kept,
		characters,
		truncated,
	};
}
