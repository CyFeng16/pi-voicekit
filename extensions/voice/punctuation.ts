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
 * Spec: docs/superpowers/specs/2026-09-28-punctuation-replacing-llm-polish-design.md §4.2–§4.4
 */

import { loadSherpa, getSherpaModule } from "./sherpa-loader";
import {
	ensurePunctuationModel,
	isPunctuationModelReady,
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
/** The background prepare in flight — from the moment it is queued until it settles. */
let prepareInFlight: Promise<void> | null = null;
/** Bumped by `resetPunctuationForTest`, so work started earlier cannot land in a later test. */
let generation = 0;

/**
 * How a queued prepare is started. `setTimeout(task, 0)` by default: the timer can only run once
 * the caller's stack has unwound, so `preparePunctuation()` returns before a single byte is read,
 * hashed or downloaded (spec invariant 7). `resetPunctuationForTest` replaces it for tests.
 */
function runOnNextTurn(task: () => void): void {
	setTimeout(task, 0);
}

let startPrepare: (task: () => void) => void = runOnNextTurn;

/** 4 threads — the configuration the 526-544 ms load and the p50 2.9 ms calls were measured with. */
const PUNCTUATION_NUM_THREADS = 4;

export interface PreparePunctuationOptions {
	/** Test seam — model lifecycle. Defaults to `ensurePunctuationModel`. */
	ensure?: (options?: EnsurePunctuationModelOptions) => Promise<boolean>;
	/** Test seam — directory the engine is built from. Defaults to `punctuationModelPath()`. */
	modelDir?: string;
	/** Test seam — engine factory; also bypasses the native-module load. Defaults to sherpa. */
	createEngine?: (modelDir: string) => PunctuationEngine;
	/**
	 * Diagnostics hook — called, off the caller's stack, when a prepare settles without producing
	 * an engine: a transfer that failed or could not be verified, a native-module load failure, or
	 * a throwing construction. It is the only signal that covers a failed download, because
	 * `punctuateWithStatus` reports "no usable model" and the dictation path must not ask
	 * `isPunctuationModelReady()` (it hashes unverified files). Every failure path of the
	 * lifecycle calls it, so a caller that only wants to tell the user once owns that once-ness.
	 * A throw from the hook is swallowed: diagnostics never break the fail-open lifecycle.
	 */
	onUnavailable?: () => void;
	/** Test seam — readiness check used by `requirePresent`. Defaults to `isPunctuationModelReady`. */
	isReady?: (modelDir: string) => boolean;
	/**
	 * Warm start only: build the engine from a model that is already on disk and verified, and
	 * transfer nothing. A missing model is left missing until a dictation genuinely needs it
	 * (spec §4.2), and a decline is not a failure — nothing was attempted, so no notice is owed
	 * and the reason stays `no-model` rather than `load-failed`.
	 */
	requirePresent?: boolean;
	/**
	 * Reported, off the caller's stack, when a prepare is about to transfer the model because it is
	 * not on disk. This is the only place that can tell a first download from an engine that is
	 * merely still being built, so a "downloading 285 MB" notice hangs off it and never fires for
	 * a model that is already present. A throw from the hook is swallowed.
	 */
	onTransfer?: () => void;
}

/**
 * Prepare the engine in the background: queue the work and return. The files are verified, the
 * model is downloaded if needed, and the engine is constructed — all of it after the caller has
 * resumed, so no part of it is ever paid for inside a dictation (spec invariant 7). Safe to call
 * on every qualifying dictation; it never throws, does nothing once the engine exists, and
 * repeated calls — including calls made before the queued work starts — share one prepare. The
 * 544 ms construction is allowed to happen here and nowhere else, and nothing is constructed
 * until the files verify (spec §6.5). A prepare that settles without an engine reports through
 * `onUnavailable`, so a caller can tell "still running" from "gave up" without checking readiness.
 */
export function preparePunctuation(options: PreparePunctuationOptions = {}): void {
	if (engine || prepareInFlight) return;

	// Claim the slot synchronously, before anything is queued, so a second qualifying dictation in
	// the same tick — or in the window before the scheduler runs — joins this prepare instead of
	// queueing another.
	const gen = generation;
	prepareInFlight = new Promise<void>((resolve) => {
		const run = (): void => {
			void prepareInBackground(options, gen)
				.catch(() => {
					if (generation === gen) loadFailed = true;
				})
				.finally(() => {
					// Only the prepare of this generation may clear the slot; a reset may already have
					// installed a newer one.
					if (generation === gen) prepareInFlight = null;
					resolve();
				});
		};
		try {
			startPrepare(run);
		} catch {
			// Only reachable through the test seam. A scheduler that cannot queue is a failed prepare,
			// and the caller — a dictation — must not see the throw.
			if (generation === gen) {
				loadFailed = true;
				prepareInFlight = null;
			}
			resolve();
		}
	});
}

async function prepareInBackground(options: PreparePunctuationOptions, gen: number): Promise<void> {
	try {
		// A warm start builds only from a model that is already on disk and verified; a dictation's
		// prepare that finds no model is about to transfer one, which is what the notice hangs off.
		const isReady = options.isReady ?? isPunctuationModelReady;
		const ready = isReady(options.modelDir ?? punctuationModelPath());
		if (!ready) {
			if (options.requirePresent) return;
			reportTransfer(options);
		}

		const ensure = options.ensure ?? ensurePunctuationModel;
		if (!(await ensure({ modelDir: options.modelDir }))) {
			// No usable model: it is absent, the transfer failed, or the files did not verify. The
			// reason stays `no-model` (the model is not there); the hook is what tells a caller that
			// the prepare gave up rather than still running.
			if (generation === gen) reportUnavailable(options);
			return;
		}
		if (generation !== gen || engine) return;

		const modelDir = options.modelDir ?? punctuationModelPath();
		let create = options.createEngine;
		if (!create) {
			// The engine needs the native module; loading it is cached and idempotent.
			if (!(await loadSherpa())) {
				if (generation === gen) {
					loadFailed = true;
					reportUnavailable(options);
				}
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
		if (generation === gen) {
			loadFailed = true;
			reportUnavailable(options);
		}
	}
}

/** Run the diagnostics hook without letting it reach the lifecycle — `preparePunctuation` must never throw. */
function reportUnavailable(options: PreparePunctuationOptions): void {
	try {
		options.onUnavailable?.();
	} catch {
		// A thrown notice is a lost notice, not a broken prepare.
	}
}

/** Same rules as `reportUnavailable`: diagnostics never break the fail-open lifecycle. */
function reportTransfer(options: PreparePunctuationOptions): void {
	try {
		options.onTransfer?.();
	} catch {
		// A thrown notice is a lost notice, not a broken prepare.
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
 * Test seam: replace the engine, clear the lifecycle state and restore (or replace) the scheduler
 * that starts the queued prepare. Called with no argument (or null) it means "no engine" and the
 * production scheduler — the cold start a fresh process sees.
 */
export function resetPunctuationForTest(
	next: PunctuationEngine | null = null,
	scheduler: ((task: () => void) => void) | null = null
): void {
	generation++;
	engine = next ?? null;
	loadFailed = false;
	prepareInFlight = null;
	startPrepare = scheduler ?? runOnNextTurn;
}

// ─── Applicability ───────────────────────────────────────────────────────────

/**
 * The threshold of spec §4.3, calibrated from AISHELL-4: reference transcripts measure 1 mark
 * per 17.3 characters (§9), so a properly punctuated Chinese text sits above 1 mark per 20
 * characters (0.05) while an unpunctuated recogniser output sits far below it.
 */
export const PUNCTUATION_DENSITY_MAX = 0.05;

/** True when `text` contains at least one CJK ideograph (Han script). */
export function hasCjk(text: string): boolean {
	return /\p{Script=Han}/u.test(text);
}

/**
 * Marks per code point, `0` for input with no code points.
 *
 * NFKC-normalized first (ruling R8) so numerator and denominator come from the same string. NFKC
 * is not numerator-neutral: it can change the code-point count (U+337F `㍿` becomes four
 * characters) and it can fold a compatibility form that is outside the mark set into marks (`‼`
 * U+203C becomes `!!`, so `这是中文‼` measures 1/3). That is intended — both sides of the ratio are
 * read from the normalized text. The marks the set does carry are invariant, because it holds both
 * the ASCII and the full-width forms (`。` and `、` are untouched by NFKC).
 */
export function punctuationDensity(text: string): number {
	const normalized = text.normalize("NFKC");
	const codePoints = Array.from(normalized).length;
	if (codePoints === 0) return 0;
	return countMarks(normalized) / codePoints;
}

/**
 * Why the applicability rule declined — or `"needed"`. Diagnostics only: the switch is named
 * before the text is read, so a `/voice-punctuation status` line never blames the transcript for
 * a step the user turned off (spec §4.6).
 */
export type PunctuationGate = "off" | "no-cjk" | "dense" | "needed";

/**
 * The applicability rule of spec §4.3, in the form the diagnostics need.
 *
 * No model identity, catalogue flag, provider or network state takes part (invariant 5).
 */
export function punctuationGate(text: string, enabled: boolean): PunctuationGate {
	if (!enabled) return "off";
	if (!hasCjk(text)) return "no-cjk";
	if (punctuationDensity(text) >= PUNCTUATION_DENSITY_MAX) return "dense";
	return "needed";
}

/**
 * The applicability rule of spec §4.3 — a pure function of the text and the switch.
 *
 * A transcript is punctuated only when the switch is on, the text contains CJK, and its
 * punctuation density is strictly below `PUNCTUATION_DENSITY_MAX`.
 */
export function shouldPunctuate(text: string, enabled: boolean): boolean {
	return punctuationGate(text, enabled) === "needed";
}

/** Everything the completion path needs from one dictation's punctuation step. */
export interface PunctuationStageResult {
	text: string;
	status: PunctuationStatus;
	gate: PunctuationGate;
}

/**
 * The pipeline's punctuation step in one call: decide (the gate), apply (the splice) and report
 * both, which is what a caller needs to write the transcript and to explain the decision
 * afterwards. The stage is text-in/text-out and knows nothing about the recogniser, so any
 * transcript source can be routed through it (spec §4.4).
 */
export function punctuateStage(text: string, enabled: boolean): PunctuationStageResult {
	const gate = punctuationGate(text, enabled);
	return { gate, ...punctuateWithStatus(text, gate === "needed") };
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
