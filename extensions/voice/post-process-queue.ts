/**
 * Segmented transcript post-processing: a bounded, fail-open polish queue.
 *
 * Pure and dependency-injected like ./post-process: no Pi types, no TUI, no filesystem
 * and no network. The model call arrives as `call`, so ordering, the concurrency cap,
 * the per-segment timeout, the single retry and per-segment isolation are all provable offline.
 *
 * The cap counts real calls, not segment promises: a slot is released when the injected
 * transport settles, so a caller that ignores the abort signal keeps its slot after its
 * segment timed out instead of letting a hung endpoint pile up calls past the cap.
 *
 * Spec: docs/superpowers/specs/2026-09-26-polish-pipeline-design.md §4.2, §4.3, §4.4
 * (a local design record, not part of the published package)
 */

import {
	polishSamplingOptions,
	polishTranscript,
	type AssistantLike,
	type PolishRequest,
	type PolishResult,
} from "./post-process";
import { assembleContext, DEFAULT_CONTEXT_LIMITS, type ContextLimits, type EntryLike } from "./post-process-context";

/**
 * Start at most this many segment calls at once. A long dictation must not open one request
 * per segment, and wall-clock must stay close to the slowest segment rather than their sum
 * (spec §4.2, open question 1).
 */
export const POLISH_QUEUE_CONCURRENCY = 3;

/** The extra request fields `polishSamplingOptions` decided for one segment. */
export interface PolishSampling {
	samplingParams?: { reasoning_effort: string };
}

/**
 * The polish request as the injected caller sees it: the prompt plus this segment's sampling
 * decision. The caller forwards `samplingParams` to its transport options; it is absent when
 * the model has no thinking to gate.
 */
export type QueuePolishRequest = PolishRequest & PolishSampling;

/** The model call, injected. The queue decides `samplingParams` per segment. */
export type PolishQueueCaller = (request: QueuePolishRequest, signal: AbortSignal) => Promise<AssistantLike>;

export interface SegmentOutcome {
	index: number;
	status: "applied" | "fallback";
	/** What this segment contributes: the rewrite when applied, its own raw text otherwise. */
	text: string;
	reason?: string;
	retried: boolean;
	latencyMs: number;
}

export interface QueueResult {
	/** The ordered join of every segment outcome (spec §4.2 stitching rule). */
	text: string;
	segments: SegmentOutcome[];
	polished: number;
	failed: number;
	retried: number;
}

export interface PolishQueue {
	/** Enqueue one recogniser segment. Empty text is skipped; work starts immediately. */
	push(index: number, raw: string): void;
	/** Barrier for one dictation: resolves once every segment pushed before this call settled. */
	finish(): Promise<QueueResult>;
}

export interface PolishQueueOptions {
	call: PolishQueueCaller;
	/** Per-segment timeout, the same knob as the single-call path (`postProcessTimeoutMs`). */
	timeoutMs: number;
	/** Session context entries; attached to segment 0 only (spec §4.3). */
	entries?: readonly EntryLike[];
	limits?: ContextLimits;
	/** The model whose thinking policy gates each segment; absent or non-reasoning keeps thinking on. */
	model?: { reasoning?: boolean } | undefined | null;
	/** Defaults to POLISH_QUEUE_CONCURRENCY; clamped to at least one. */
	concurrency?: number;
	/**
	 * One pass id for the whole queue. Checked before each attempt is scheduled (first try and
	 * retry), so an invalidated pass stops sending new requests instead of merely discarding
	 * the answers; `polishTranscript` checks it again before and after every call.
	 */
	isCurrent?: () => boolean;
	/** Injected clock, so tests can pin latency without waiting. */
	now?: () => number;
	debug?: (reason: string, data?: Record<string, unknown>) => void;
}

interface SegmentJob {
	index: number;
	raw: string;
}

/** One real call, which owns a concurrency slot until the transport settles - timeout or not. */
interface LiveCall {
	settled: boolean;
	orphaned: boolean;
}

/** One attempt: its result, whether a request really went out, or that no request was sent. */
interface AttemptRun {
	issued: boolean;
	denied: boolean;
	/** The pass lost ownership before this attempt could send anything. */
	stale: boolean;
	result: PolishResult | null;
	error?: unknown;
}

/**
 * Stitch segment texts into one transcript. Two adjacent CJK characters take no separator,
 * so Chinese stays "这是第一段这是第二段" while English keeps "first part second part"; every
 * other boundary takes a single space, which is what zh-en dictation reads as. Empty parts
 * are dropped so a silent segment cannot inject a stray space, and each part is trimmed at
 * its edges only.
 */
export function joinSegments(parts: readonly string[]): string {
	let joined = "";
	for (const part of parts) {
		const text = part.trim();
		if (!text) continue;
		if (joined && needsSeparator(joined, text)) joined += " ";
		joined += text;
	}
	return joined;
}

function needsSeparator(left: string, right: string): boolean {
	return !(isCjk(lastCodePoint(left)) && isCjk(firstCodePoint(right)));
}

function firstCodePoint(text: string): number {
	return text.codePointAt(0) ?? -1;
}

/** The code point at the end of `text`, surrogate pairs included. */
function lastCodePoint(text: string): number {
	const last = text.charCodeAt(text.length - 1);
	const previous = text.charCodeAt(text.length - 2);
	if (last >= 0xdc00 && last <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) {
		return (previous - 0xd800) * 0x400 + (last - 0xdc00) + 0x10000;
	}
	return last;
}

/**
 * CJK for the stitching rule: ideographs and their extensions, kana, Bopomofo, CJK
 * punctuation and fullwidth forms. Hangul is left out on purpose — Korean separates words
 * with spaces.
 */
function isCjk(codePoint: number): boolean {
	return (
		(codePoint >= 0x2e80 && codePoint <= 0x2eff) || // CJK Radicals Supplement
		(codePoint >= 0x3000 && codePoint <= 0x303f) || // CJK Symbols and Punctuation
		(codePoint >= 0x3040 && codePoint <= 0x30ff) || // Hiragana and Katakana
		(codePoint >= 0x3100 && codePoint <= 0x312f) || // Bopomofo
		(codePoint >= 0x3190 && codePoint <= 0x319f) || // Kanbun
		(codePoint >= 0x31c0 && codePoint <= 0x31ef) || // CJK Strokes
		(codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK Unified Ideographs Extension A
		(codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK Unified Ideographs
		(codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK Compatibility Ideographs
		(codePoint >= 0xfe30 && codePoint <= 0xfe4f) || // CJK Compatibility Forms
		(codePoint >= 0xff01 && codePoint <= 0xff60) || // Fullwidth forms
		(codePoint >= 0x20000 && codePoint <= 0x3ffff) // Extensions B and beyond
	);
}

/** Same shape as `resolveTurns` in post-process-context: floor locally, never let 0 through. */
function resolveConcurrency(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return POLISH_QUEUE_CONCURRENCY;
	return Math.max(1, Math.floor(value));
}

/**
 * One polish queue per dictation. Every segment runs `polishTranscript` with the same
 * guardrails as the single-call path, so nothing here re-implements the prompt, the output
 * validation or the fail-open fallback.
 */
export function createPolishQueue(options: PolishQueueOptions): PolishQueue {
	const concurrency = resolveConcurrency(options.concurrency);
	const limits = options.limits ?? DEFAULT_CONTEXT_LIMITS;
	const clock = (): number => {
		try {
			return (options.now ?? Date.now)();
		} catch {
			// A broken injected clock must not cost the user their dictation.
			return Date.now();
		}
	};
	/** Raw text by index: the join order, and the reference turn for the next segment. */
	const raws = new Map<number, string>();
	const outcomes = new Map<number, SegmentOutcome>();
	/**
	 * Real calls in flight, and how many of them outlived their segment. A slot is released when
	 * the transport settles, never when the segment deadline fires: an injected caller that
	 * ignores the abort signal keeps its slot, so a hung endpoint cannot push the live request
	 * count past `concurrency`. `running` counts segments whose outcome is not decided yet.
	 */
	let liveCalls = 0;
	let orphanedCalls = 0;
	let running = 0;
	const slotWaiters: ((granted: boolean) => void)[] = [];
	let finished: Promise<QueueResult> | null = null;
	let resolveIdle: (() => void) | null = null;

	function orderedIndexes(): number[] {
		return [...raws.keys()].sort((left, right) => left - right);
	}

	function hasFreeSlot(): boolean {
		return liveCalls < concurrency;
	}

	/**
	 * True when no slot can free on its own: every live call has already outlived its deadline,
	 * so waiting only delays the fallback. Every issued call sits inside a `polishTranscript`
	 * timeout, so a live call either settles or becomes an orphan within one deadline.
	 */
	function capacityStuck(): boolean {
		return !hasFreeSlot() && orphanedCalls >= liveCalls;
	}

	/** After a slot frees or an orphan appears: grant while slots last, else deny when stuck. */
	function wakeWaiters(): void {
		while (slotWaiters.length > 0) {
			if (hasFreeSlot()) {
				liveCalls += 1;
				slotWaiters.shift()!(true);
				continue;
			}
			if (capacityStuck()) {
				for (const waiter of slotWaiters.splice(0)) waiter(false);
			}
			return;
		}
	}

	/** Take a slot right now, so a pushed segment reaches its caller without a microtask delay. */
	function tryTakeSlot(): boolean {
		if (!hasFreeSlot()) return false;
		liveCalls += 1;
		return true;
	}

	/** Wait for a slot; false means no live call will ever free one, so the segment falls back. */
	function waitForSlot(): Promise<boolean> {
		if (tryTakeSlot()) return Promise.resolve(true);
		if (capacityStuck()) return Promise.resolve(false);
		return new Promise<boolean>((resolve) => {
			slotWaiters.push(resolve);
		});
	}

	function releaseSlot(orphaned: boolean): void {
		if (orphaned) orphanedCalls = Math.max(0, orphanedCalls - 1);
		liveCalls = Math.max(0, liveCalls - 1);
		wakeWaiters();
	}

	/** The attempt is over but its call never settled: the slot stays held until it does. */
	function markOrphaned(call: LiveCall): void {
		if (call.orphaned) return;
		call.orphaned = true;
		orphanedCalls += 1;
		wakeWaiters();
	}

	function resolveIdleNow(): void {
		if (!resolveIdle || running > 0) return;
		const resolve = resolveIdle;
		resolveIdle = null;
		resolve();
	}

	function settle(job: SegmentJob, outcome: SegmentOutcome): void {
		outcomes.set(job.index, outcome);
		running -= 1;
		resolveIdleNow();
	}

	/**
	 * Spec §4.3: segment 0 carries the session context; a later segment carries the previous
	 * segment's raw text as a single reference turn instead. The reference turn goes through
	 * `assembleContext` so the same caps apply to it as to the session context.
	 */
	function entriesForSegment(index: number): readonly EntryLike[] {
		if (index === 0) return options.entries ?? [];
		const previous = raws.get(index - 1);
		if (!previous) return [];
		const reference = assembleContext([{ type: "message", message: { role: "user", content: previous } }], limits);
		const text = reference.turns
			.map((turn) => turn.text)
			.join("\n")
			.trim();
		if (!text) return [];
		return [{ type: "message", message: { role: "user", content: text } }];
	}

	function debugFor(index: number): ((reason: string, data?: Record<string, unknown>) => void) | undefined {
		const debug = options.debug;
		if (!debug) return undefined;
		return (reason, data) => {
			try {
				debug(reason, { ...data, segment: index });
			} catch {
				// The debug hook is observational: a throw here must not break fail-open.
			}
		};
	}

	function appliedOutcome(job: SegmentJob, text: string, retried: boolean, started: number): SegmentOutcome {
		return { index: job.index, status: "applied", text, retried, latencyMs: Math.max(0, clock() - started) };
	}

	function fallbackOutcome(
		job: SegmentJob,
		reason: string | undefined,
		retried: boolean,
		started: number
	): SegmentOutcome {
		const outcome: SegmentOutcome = {
			index: job.index,
			status: "fallback",
			text: job.raw,
			retried,
			latencyMs: Math.max(0, clock() - started),
		};
		if (reason !== undefined) outcome.reason = reason;
		return outcome;
	}

	function reasonOf(run: AttemptRun): string | undefined {
		if (run.stale) return "invalidated";
		if (run.error !== undefined) {
			return run.error instanceof Error && run.error.message ? run.error.message : "segment-error";
		}
		if (run.denied) return "no-capacity";
		return run.result?.reason;
	}

	/** True once the pass that owns this queue has been invalidated. A throwing check keeps
	 * fail-open intact: it must never block a dictation that might still be valid. */
	function stale(): boolean {
		try {
			return options.isCurrent?.() === false;
		} catch {
			return false;
		}
	}

	/**
	 * Spec §4.2: one retry, and only for a call that timed out or failed at the transport. A
	 * guardrail rejection means the rewrite was wrong rather than slow, so repeating it cannot
	 * help; an attempt that never issued a request has nothing to repeat.
	 */
	function isRetryable(run: AttemptRun): boolean {
		if (!run.issued || !run.result || run.result.status !== "rejected") return false;
		return run.result.reason === "timeout" || run.result.reason === "call-failed";
	}

	function unexpectedOutcome(job: SegmentJob, error: unknown, latencyMs: number): SegmentOutcome {
		return {
			index: job.index,
			status: "fallback",
			text: job.raw,
			reason: error instanceof Error && error.message ? error.message : "segment-error",
			retried: false,
			latencyMs,
		};
	}

	/**
	 * One model attempt. The slot is taken before `polishTranscript` starts its deadline, so a
	 * segment that waited for capacity still gets its full timeout, and the slot goes back only
	 * once the transport settles.
	 */
	async function runAttempt(job: SegmentJob, forceOff: boolean): Promise<AttemptRun> {
		// Invalidation is checked before a slot is taken: a cancelled or superseded pass must stop
		// scheduling requests, not just ignore their answers.
		if (stale()) return { issued: false, denied: false, stale: true, result: null };
		if (!tryTakeSlot() && !(await waitForSlot())) return { issued: false, denied: true, stale: false, result: null };
		// The pass may have died while this segment waited for a slot.
		if (stale()) {
			releaseSlot(false);
			return { issued: false, denied: false, stale: true, result: null };
		}
		const call: LiveCall = { settled: false, orphaned: false };
		let issued = false;
		try {
			const sampling = polishSamplingOptions(options.model, job.raw.length, forceOff);
			const result = await polishTranscript({
				raw: job.raw,
				entries: entriesForSegment(job.index),
				limits,
				timeoutMs: options.timeoutMs,
				timestamp: clock(),
				isCurrent: options.isCurrent,
				call: async (request, signal) => {
					issued = true;
					try {
						return await options.call({ ...request, ...sampling }, signal);
					} finally {
						call.settled = true;
						releaseSlot(call.orphaned);
					}
				},
				debug: debugFor(job.index),
			});
			if (!call.settled) markOrphaned(call);
			return { issued, denied: false, stale: false, result };
		} catch (error) {
			// `polishTranscript` normally reports through its result; this only covers a fault
			// thrown before it could invoke the caller.
			if (!issued) releaseSlot(false);
			else if (!call.settled) markOrphaned(call);
			return { issued, denied: false, stale: false, result: null, error };
		}
	}

	async function runSegment(job: SegmentJob): Promise<SegmentOutcome> {
		const started = clock();
		try {
			const first = await runAttempt(job, false);
			if (first.result?.status === "applied") return appliedOutcome(job, first.result.text, false, started);
			const firstReason = reasonOf(first);
			if (!isRetryable(first)) return fallbackOutcome(job, firstReason, false, started);
			// Never retry for a pass that lost ownership while the first attempt ran.
			if (stale()) return fallbackOutcome(job, "invalidated", false, started);
			const second = await runAttempt(job, true);
			if (second.result?.status === "applied") return appliedOutcome(job, second.result.text, second.issued, started);
			// A retry that never reached the transport leaves the first failure as the reason.
			const reason = second.issued ? (reasonOf(second) ?? firstReason) : firstReason;
			return fallbackOutcome(job, reason, second.issued, started);
		} catch (error) {
			// Fail-open, last resort: this segment keeps its own raw text.
			return unexpectedOutcome(job, error, Math.max(0, clock() - started));
		}
	}

	function buildResult(): QueueResult {
		const segments: SegmentOutcome[] = [];
		for (const index of orderedIndexes()) {
			const outcome = outcomes.get(index);
			if (outcome) {
				segments.push(outcome);
			} else {
				// A pushed segment always settles before finish() resolves, so this only fires if
				// an unexpected throw slipped past the per-segment catch. Keep the raw text.
				segments.push({
					index,
					status: "fallback",
					text: raws.get(index) ?? "",
					reason: "missing-outcome",
					retried: false,
					latencyMs: 0,
				});
			}
		}
		return {
			text: joinSegments(segments.map((segment) => segment.text)),
			segments,
			polished: segments.filter((segment) => segment.status === "applied").length,
			failed: segments.filter((segment) => segment.status === "fallback").length,
			retried: segments.filter((segment) => segment.retried).length,
		};
	}

	/** Every segment raw, order kept: the last-resort result if the builder itself faults. */
	function rawOnlyResult(reason: string): QueueResult {
		const segments: SegmentOutcome[] = orderedIndexes().map((index) => ({
			index,
			status: "fallback" as const,
			text: raws.get(index) ?? "",
			reason,
			retried: false,
			latencyMs: 0,
		}));
		return {
			text: joinSegments(segments.map((segment) => segment.text)),
			segments,
			polished: 0,
			failed: segments.length,
			retried: 0,
		};
	}

	return {
		push(index: number, raw: string): void {
			// finish() is the barrier for one dictation: anything offered afterwards belongs to
			// a pass that is already being written, so it can only be dropped.
			if (finished) return;
			// Silence contributes nothing, exactly as today's segment concatenation skips it.
			if (!raw.trim()) return;
			// One segment per index: a repeated push would duplicate the text in the join.
			if (raws.has(index)) return;
			raws.set(index, raw);
			running += 1;
			const job: SegmentJob = { index, raw };
			// Every pushed segment starts here; the slot pool, not this call site, bounds requests.
			void runSegment(job).then(
				(outcome) => settle(job, outcome),
				(error: unknown) => settle(job, unexpectedOutcome(job, error, 0))
			);
		},

		finish(): Promise<QueueResult> {
			if (!finished) {
				finished = new Promise<QueueResult>((resolve) => {
					// The result builder is the last place a fault could cost the dictation its
					// text, so a throw still resolves with the ordered raw transcript.
					resolveIdle = () => {
						try {
							resolve(buildResult());
						} catch {
							resolve(rawOnlyResult("result-error"));
						}
					};
				});
				// Nothing pushed: resolve in this tick instead of waiting for a segment that may
				// never come.
				resolveIdleNow();
			}
			return finished;
		},
	};
}
