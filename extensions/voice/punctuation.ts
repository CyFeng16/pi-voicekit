/**
 * Offline punctuation — the deterministic, marks-only step that replaced the LLM polish pass.
 *
 * The model may only *add* marks, and its raw output is never returned: `spliceMarks` aligns it
 * against the input on the stream of characters that are neither marks nor whitespace, refuses
 * anything that does not preserve that stream, and inserts the model's marks into the untouched
 * input. Identifiers, spaces, digits and case therefore survive byte-exactly (spec invariant 1).
 * Every failure path returns the input unchanged (invariant 2), and the engine is constructed in
 * `preparePunctuation`'s background pass — never inside a dictation (invariant 7).
 *
 * Spec: docs/superpowers/specs/2026-09-28-punctuation-replacing-llm-polish-design.md §4.2, §4.4
 */

import { loadSherpa, getSherpaModule } from "./sherpa-loader";
import {
	ensurePunctuationModel,
	punctuationModelFilePath,
	punctuationModelPath,
	type EnsurePunctuationModelOptions,
} from "./punctuation-model";

// ─── Types ───────────────────────────────────────────────────────────────────

/** The engine seam: the single sherpa method this module uses. */
export interface PunctuationEngine {
	addPunct(text: string): string;
}

export type PunctuationReason = "no-model" | "load-failed" | "empty-input" | "altered-text" | "not-needed" | "error";

export interface PunctuationStatus {
	applied: boolean;
	reason?: PunctuationReason;
	/** Marks in the text handed in. */
	marksBefore: number;
	/** Marks in the text handed back — equal to `marksBefore` unless a splice was applied. */
	marksAfter: number;
	elapsedMs: number;
}

export interface PunctuationResult {
	text: string;
	status: PunctuationStatus;
}

// ─── Marks and streams ───────────────────────────────────────────────────────

/** The mark set of spec invariant 1 — the only characters this step may insert. */
const MARKS = new Set([..."。！？；：、，,.!?;:"]);

/** Whitespace is taken from the input only; the model's own spacing is never trusted. */
const WHITESPACE = /\s/;

function isMark(ch: string): boolean {
	return MARKS.has(ch);
}

function isWhitespace(ch: string): boolean {
	return WHITESPACE.test(ch);
}

/** Marks in `text`, counted over code points like the density rule (spec §4.3). */
function countMarks(text: string): number {
	let count = 0;
	for (const ch of text) {
		if (isMark(ch)) count++;
	}
	return count;
}

/** The stream the splice aligns on: every character that is neither a mark nor whitespace. */
function marklessStream(text: string): string {
	const kept: string[] = [];
	for (const ch of text) {
		if (!isMark(ch) && !isWhitespace(ch)) kept.push(ch);
	}
	return kept.join("");
}

/** True when the last character already emitted is a mark. */
function hasMarkBefore(emitted: readonly string[]): boolean {
	const last = emitted[emitted.length - 1];
	return last !== undefined && isMark(last);
}

/** True when the input's next non-whitespace character at the cursor is already a mark. */
function hasMarkAhead(input: readonly string[], cursor: number): boolean {
	for (let i = cursor; i < input.length; i++) {
		const ch = input[i]!;
		if (isWhitespace(ch)) continue;
		return isMark(ch);
	}
	return false;
}

// ─── Splicing ────────────────────────────────────────────────────────────────

/**
 * Insert the model's marks into `input`, or refuse with `undefined`.
 *
 * The model's mark region is aligned on the stream of characters that are neither marks nor
 * whitespace: the two streams must be identical, otherwise the output altered something the step
 * must never touch and the input is kept. Marks are taken from the model output only — its
 * whitespace is ignored, which is what repairs the measured `base _ url` and moved CJK-boundary
 * spaces. A mark is dropped when the position it would take already carries a mark, which is what
 * makes the step idempotent and keeps an already-punctuated transcript exactly as it was.
 */
export function spliceMarks(input: string, modelOutput: string): string | undefined {
	if (marklessStream(modelOutput) !== marklessStream(input)) return undefined;

	const inputChars = Array.from(input);
	const emitted: string[] = [];
	let cursor = 0;

	for (const ch of modelOutput) {
		if (isWhitespace(ch)) continue; // whitespace always comes from the input, never from the model

		if (isMark(ch)) {
			// The mark belongs after everything emitted so far, i.e. before the input's own pending
			// run of marks and whitespace; it is redundant when a mark already sits at that spot.
			if (hasMarkBefore(emitted) || hasMarkAhead(inputChars, cursor)) continue;
			emitted.push(ch);
			continue;
		}

		// A stream character: copy the input forward through the character it matches.
		while (cursor < inputChars.length) {
			const inputChar = inputChars[cursor]!;
			emitted.push(inputChar);
			cursor++;
			if (!isMark(inputChar) && !isWhitespace(inputChar)) break;
		}
	}

	// `concat` rather than `push(...tail)`: a long dictation must not hit the argument-count limit.
	return emitted.concat(inputChars.slice(cursor)).join("");
}

// ─── Engine lifecycle ────────────────────────────────────────────────────────

/** The constructed engine, or null while no usable model is present. */
let engine: PunctuationEngine | null = null;
/** Set when a background prepare could not produce an engine, so status can explain why. */
let loadFailed = false;
/** The background prepare in flight — one at a time, however many dictations finish. */
let prepareInFlight: Promise<void> | null = null;
/** Bumped by `resetPunctuationForTest`, so work started earlier cannot land in a later test. */
let generation = 0;

/** 4 threads — the configuration the 526-544 ms load and the p50 2.9 ms calls were measured with. */
const PUNCTUATION_NUM_THREADS = 4;

export interface PreparePunctuationOptions {
	/** Test seam — model lifecycle. Defaults to `ensurePunctuationModel`. */
	ensure?: (options?: EnsurePunctuationModelOptions) => Promise<boolean>;
	/** Test seam — directory the engine is built from. Defaults to `punctuationModelPath()`. */
	modelDir?: string;
	/** Test seam — engine factory; also bypasses the native-module load. Defaults to sherpa. */
	createEngine?: (modelDir: string) => PunctuationEngine;
}

/**
 * Prepare the engine in the background: make sure the files are present and verified, then
 * construct the engine once. Safe to call on every qualifying dictation and cheap once the engine
 * exists — it never throws and never blocks the caller. The 544 ms construction is allowed to
 * happen here and nowhere else, so no dictation ever waits for it (spec invariant 7), and nothing
 * is constructed until the files verify (spec §6.5).
 */
export function preparePunctuation(options: PreparePunctuationOptions = {}): void {
	if (engine || prepareInFlight) return;

	const gen = generation;
	prepareInFlight = prepareInBackground(options, gen).finally(() => {
		// Only the prepare of this generation may clear the slot; a reset may already have
		// installed a newer one.
		if (generation === gen) prepareInFlight = null;
	});
}

async function prepareInBackground(options: PreparePunctuationOptions, gen: number): Promise<void> {
	try {
		const ensure = options.ensure ?? ensurePunctuationModel;
		if (!(await ensure({ modelDir: options.modelDir }))) return;
		if (generation !== gen || engine) return;

		const modelDir = options.modelDir ?? punctuationModelPath();
		let create = options.createEngine;
		if (!create) {
			// The engine needs the native module; loading it is cached and idempotent.
			if (!(await loadSherpa())) {
				if (generation === gen) loadFailed = true;
				return;
			}
			if (generation !== gen || engine) return;
			create = createSherpaEngine;
		}

		const created = create(modelDir);
		if (generation === gen && !engine) {
			engine = created;
			loadFailed = false;
		}
	} catch {
		if (generation === gen) loadFailed = true;
	}
}

/** Build the sherpa punctuation engine — the one construction site (spec §4.2, §4.4). */
function createSherpaEngine(modelDir: string): PunctuationEngine {
	const sherpa = getSherpaModule();
	return new sherpa.OfflinePunctuation({
		model: {
			ctTransformer: punctuationModelFilePath("model", modelDir),
			numThreads: PUNCTUATION_NUM_THREADS,
			provider: "cpu",
		},
	});
}

/**
 * Test seam: replace the engine and clear the lifecycle state. Called with no argument (or null)
 * it means "no engine" — the cold start a fresh process sees.
 */
export function resetPunctuationForTest(next: PunctuationEngine | null = null): void {
	generation++;
	engine = next ?? null;
	loadFailed = false;
	prepareInFlight = null;
}

// ─── The step ────────────────────────────────────────────────────────────────

function elapsedSince(started: number): number {
	return Math.round(performance.now() - started);
}

function unchanged(text: string, reason: PunctuationReason, marks: number, elapsedMs = 0): PunctuationResult {
	return { text, status: { applied: false, reason, marksBefore: marks, marksAfter: marks, elapsedMs } };
}

/**
 * Punctuate `text` and report what happened.
 *
 * `shouldApply` is the caller's decision (the pure rule of spec §4.3); this function never
 * re-reads configuration and never re-applies a rule. `shouldApply: false` returns the input
 * unchanged with reason `not-needed`. Every other failure — no engine, a throwing engine, a
 * refused splice — returns the input unchanged too (spec invariant 2).
 */
export function punctuateWithStatus(text: string, shouldApply: boolean): PunctuationResult {
	const marksBefore = countMarks(text);

	if (!shouldApply) return unchanged(text, "not-needed", marksBefore);
	if (text.trim().length === 0) return unchanged(text, "empty-input", marksBefore);
	if (!engine) return unchanged(text, loadFailed ? "load-failed" : "no-model", marksBefore);

	const started = performance.now();
	let raw: string;
	try {
		raw = engine.addPunct(text);
	} catch {
		return unchanged(text, "error", marksBefore, elapsedSince(started));
	}

	const spliced = spliceMarks(text, raw);
	if (spliced === undefined) return unchanged(text, "altered-text", marksBefore, elapsedSince(started));

	return {
		text: spliced,
		status: {
			applied: true,
			marksBefore,
			marksAfter: countMarks(spliced),
			elapsedMs: elapsedSince(started),
		},
	};
}

/** Convenience wrapper for callers that only need the text (spec §4.4). */
export function addPunctuation(text: string, shouldApply: boolean): string {
	return punctuateWithStatus(text, shouldApply).text;
}
