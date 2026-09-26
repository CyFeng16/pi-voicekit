/**
 * Transcript post-processing: guardrails, model resolution and the bounded pass.
 *
 * The model call is injected as `call`, so this module never imports Pi types and
 * every branch is testable offline. `arguments`-style tool blocks never appear here
 * on purpose (spec D9).
 *
 * Spec: docs/superpowers/specs/2026-09-26-stt-post-processing-design.md §4.4, §4.6, §4.9
 * (a local design record, not part of the published package)
 */

import { assembleContext, type ContextLimits, type EntryLike } from "./post-process-context";
import { buildPolishRequest, type PolishRequest } from "./post-process-prompt";

// Re-exported so the tests (and any future caller) can type a request without reaching
// into the prompt module; the package has no pi-ai type to reuse here.
export type { PolishRequest };

export interface AssistantLike {
	stopReason?: string;
	errorMessage?: string;
	content?: unknown;
}

export type PolishCaller = (request: PolishRequest, signal: AbortSignal) => Promise<AssistantLike>;

export interface PolishResult {
	status: "applied" | "rejected" | "skipped";
	/** The text the caller should use: the rewrite when applied, the raw transcript otherwise. */
	text: string;
	reason?: string;
	contextChars: number;
	truncatedContext: boolean;
}

export interface ParsedModelRef {
	kind: "session" | "explicit" | "invalid";
	provider?: string;
	modelId?: string;
	raw: string;
}

export function parseModelRef(value: string | undefined): ParsedModelRef {
	const raw = (value ?? "").trim();
	if (!raw || raw === "session") return { kind: "session", raw };
	const slash = raw.indexOf("/");
	// Anything that is not `provider/modelId` is a configuration error, NOT a request to
	// use the session model: silently switching the recipient of the transcript is what
	// D8 forbids, so it resolves to `invalid` and the caller keeps the raw text.
	if (slash <= 0 || slash === raw.length - 1) return { kind: "invalid", raw };
	return { kind: "explicit", provider: raw.slice(0, slash), modelId: raw.slice(slash + 1), raw };
}

/** Resolution never falls back: a broken explicit choice keeps the raw transcript (spec D8). */
export function resolveModelChoice(
	parsed: ParsedModelRef,
	lookup: (provider: string, modelId: string) => { model: unknown; hasAuth: boolean } | undefined,
	sessionModel: unknown
): { model?: unknown; ref: string; reason?: "not-found" | "no-auth" | "no-session-model" | "malformed" } {
	if (parsed.kind === "session") {
		return sessionModel ? { model: sessionModel, ref: "session" } : { ref: "session", reason: "no-session-model" };
	}
	if (parsed.kind === "invalid") return { ref: parsed.raw, reason: "malformed" };
	const found = lookup(parsed.provider!, parsed.modelId!);
	if (!found) return { ref: parsed.raw, reason: "not-found" };
	if (!found.hasAuth) return { ref: parsed.raw, reason: "no-auth" };
	return { model: found.model, ref: parsed.raw };
}

/**
 * Rows for the model pickers — `/voice-polish model` (Task 6) and the settings panel
 * (Task 7). Values are canonical `provider/id` references, so a picker can never produce
 * a reference the resolver above would reject; the session entry is always first. Pure,
 * so it is testable without a TUI (the panel module has no render harness).
 */
export function polishModelOptions(
	models: readonly { ref: string; label: string }[],
	current: string | undefined
): { label: string; value: string }[] {
	const active = current && current !== "session" ? current : "session";
	const sessionLabel = active === "session" ? "● Session model (follow the chat)" : "Session model (follow the chat)";
	return [
		{ label: sessionLabel, value: "session" },
		...models.map((model) => ({
			label: `${model.ref === active ? "● " : ""}${model.label} (${model.ref})`,
			value: model.ref,
		})),
	];
}

const SCAFFOLD_START = /^\s*<(TRANSCRIPT|CONTEXT|CONTEXT_SUMMARY|SYSTEM_INSTRUCTIONS)[\s>]/;
// Spec section 4.6 check 4 is the authority: an output is a scaffolding echo when it starts
// with one of our tags after trimming, OR when both the opening and the closing TRANSCRIPT
// tag appear anywhere — a preamble followed by the wrapper is still an echo, not a rewrite.
const SCAFFOLD_OPEN = "<TRANSCRIPT>";
const SCAFFOLD_CLOSE = "</TRANSCRIPT>";
const MIN_RATIO = 0.3;
const MAX_RATIO = 2.0;

function textParts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as { type?: string; text?: string };
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts;
}

/** Status first, then a few narrow structural checks — never a substring hunt (spec §4.6). */
export function validatePolishOutput(
	raw: string,
	message: AssistantLike
): { accept: boolean; text: string; reason?: string } {
	if (message.stopReason !== "stop")
		return { accept: false, text: raw, reason: `stop-reason:${message.stopReason ?? "unknown"}` };
	if (typeof message.errorMessage === "string" && message.errorMessage)
		return { accept: false, text: raw, reason: "error-message" };
	const text = textParts(message.content).join("\n").trim();
	if (!text) return { accept: false, text: raw, reason: "empty-output" };
	if (SCAFFOLD_START.test(text) || (text.includes(SCAFFOLD_OPEN) && text.includes(SCAFFOLD_CLOSE)))
		return { accept: false, text: raw, reason: "scaffolding-echo" };
	const ratio = text.length / Math.max(1, raw.length);
	if (ratio < MIN_RATIO) return { accept: false, text: raw, reason: "too-short" };
	if (ratio > MAX_RATIO) return { accept: false, text: raw, reason: "too-long" };
	return { accept: true, text };
}

/**
 * Marker for "the editor text could not be read". A failed read is never treated as an
 * unchanged editor: not being able to confirm the user's text does not grant permission
 * to overwrite it (spec invariant 2).
 */
export const EDITOR_READ_FAILED = Symbol("editor-read-failed");

export type EditorRead = string | typeof EDITOR_READ_FAILED;

/**
 * Invariant 2: text — the accepted rewrite or the raw fallback — may be written only
 * while the pass still owns the flow AND the editor still holds the value the pass
 * snapshotted. Used by the normal path and by the pass's own throw path.
 */
export function decideApply(input: { tokenCurrent: boolean; editorSnapshot: string; currentEditor: EditorRead }): {
	apply: boolean;
	reason?: string;
} {
	if (!input.tokenCurrent) return { apply: false, reason: "invalidated" };
	if (input.currentEditor === EDITOR_READ_FAILED) return { apply: false, reason: "editor-unreadable" };
	if (input.currentEditor !== input.editorSnapshot) return { apply: false, reason: "editor-changed" };
	return { apply: true };
}

export interface PolishInput {
	raw: string;
	entries: readonly EntryLike[];
	limits: ContextLimits;
	timeoutMs: number;
	timestamp: number;
	call: PolishCaller;
	/** Checked after the await: false means a newer recording or session owns the editor now. */
	isCurrent?: () => boolean;
	debug?: (reason: string, data?: Record<string, unknown>) => void;
}

export async function polishTranscript(input: PolishInput): Promise<PolishResult> {
	const context = assembleContext(input.entries, input.limits);
	const shape = { contextChars: context.characters, truncatedContext: context.truncated };
	const request = buildPolishRequest(context, input.raw, input.timestamp);
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;

	try {
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				// Reject before asking for the abort: a caller that rejects synchronously on the
				// signal would otherwise win the race and be misreported as `call-failed`.
				reject(new Error("polish-timeout"));
				controller.abort();
			}, input.timeoutMs);
		});
		// The race matters: a provider that ignores the abort signal must not hold
		// the handler past the configured timeout (spec §4.1.1).
		const message = await Promise.race([input.call(request, controller.signal), timeout]);
		const verdict = validatePolishOutput(input.raw, message);
		if (!verdict.accept) {
			input.debug?.(verdict.reason ?? "rejected", shape);
			return { status: "rejected", text: input.raw, reason: verdict.reason, ...shape };
		}
		if (input.isCurrent && !input.isCurrent()) {
			return { status: "skipped", text: input.raw, reason: "invalidated", ...shape };
		}
		return { status: "applied", text: verdict.text, ...shape };
	} catch (error) {
		const reason = error instanceof Error && error.message === "polish-timeout" ? "timeout" : "call-failed";
		const result: PolishResult = { status: "rejected", text: input.raw, reason, ...shape };
		try {
			input.debug?.(reason, { ...shape, error: error instanceof Error ? error.message : String(error) });
		} catch {
			// The debug hook is observational: a throw here must not break fail-open.
		}
		return result;
	} finally {
		if (timer) clearTimeout(timer);
	}
}
