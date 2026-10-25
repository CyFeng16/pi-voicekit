/**
 * The preview worker client: one warm worker for the whole extension, one claim per recording.
 *
 * Spec: docs/superpowers/specs/2026-10-22-local-streaming-preview-design.md §4.3, §5.5, §6.3.
 *
 * The worker is deliberately not per recording. Building the recogniser costs ~650 ms [historical], and
 * the design keeps the preview worker warm between dictations (§6.3), so the client owns exactly one
 * worker for the extension's lifetime: `claim()` starts a recording, `release()` ends it and leaves the
 * worker up, and `destroy()` terminates it now (a zero-audio abort, extension shutdown).
 *
 * A worker thread is also where the protocol's asynchrony lives, so this module owns the three rules the
 * callers must not have to think about:
 *
 * - **`flush()` always settles.** It resolves on `flushed`, on the flush timeout, on a worker `failed`
 *   message, on `release()`, and on `destroy()`. A `failed` message settles every pending flush at once:
 *   the worker will never answer them, so waiting would only add the timeout to the final path.
 * - **Failure is one `degraded` per recording, never a throw.** `feed()`, `flush()` and `destroy()` are
 *   safe on any path; a worker that cannot start, dies, or stops answering becomes one
 *   `preview-worker-failed` event carrying the detail for the debug channel. That event is preceded by
 *   one `commit` freezing whatever the segment was still showing (see `freezeClaim`), so a failure never
 *   erases text the caller could already render.
 * - **No preview is not a failure.** A `null` model directory yields a claim whose methods are no-ops and
 *   that emits nothing at all — a missing preview model is the ordinary steady state (§6.2).
 *
 * The client's audio conversion mirrors the worker's: the capture child speaks 16 kHz mono PCM16LE, the
 * protocol carries float samples so nothing depends on byte order, and `preview-stream` converts back.
 *
 * The worker has no per-recording reset, because the protocol has none. Normal completion ends the last
 * segment with the stop flush; an abort mid-recording does not, so `release()` drains that abandoned
 * segment with a maintenance flush of its own. Without it the next recording's audio would continue the
 * aborted recording's online stream and its first preview would open with words the user cancelled. The
 * maintenance flush has no claim, so its events are dropped rather than misattributed to the next claim
 * — and because worker messages are processed in order, everything before its `flushed` answer belongs to
 * the recording that was just released.
 *
 * The 60 s segment cap is not here: it belongs to `preview-stream` inside the worker. This client carries
 * `"cap"` in the flush reason only because the protocol does; it never ends a segment for a cap itself.
 */

import { Worker, type Transferable } from "node:worker_threads";
import type { WorkerRequest, WorkerResponse } from "./local-preview-worker";

export type DegradeReason = "preview-worker-failed" | "preview-decode-failed";

export interface PreviewEvent {
	kind: "partial" | "commit" | "degraded";
	recordingId: string;
	revision?: number;
	segmentId?: number;
	text?: string;
	reason?: DegradeReason;
	detail?: string;
}

export type FlushReason = "pause" | "cap" | "stop";

export interface PreviewChannel {
	readonly recordingId: string;
	feed(chunk: Buffer): void;
	flush(reason: FlushReason): Promise<void>;
	/** Ends this recording's claim. The worker stays warm for the next recording. */
	release(): void;
	/** Terminates the worker now (zero-audio abort, shutdown). Idempotent. */
	destroy(): Promise<void>;
}

/** The slice of a `worker_threads` worker this client drives. Injectable so tests need no model. */
export interface PreviewWorkerLike {
	postMessage(value: unknown, transfer?: readonly Transferable[]): void;
	on(event: string, listener: (...args: unknown[]) => void): void;
	terminate(): void;
}

export interface PreviewClientOptions {
	/** `null` means no preview at all, ever: no spawn, no event, and no degradation. */
	previewModelDir: string | null;
	spawnWorker?: (url: URL) => PreviewWorkerLike;
	/** How long a posted flush may stay unanswered before the worker counts as failed. Default 5000. */
	flushTimeoutMs?: number;
	/** How long a released claim keeps the worker warm. Default 300_000. */
	idleTimeoutMs?: number;
}

export interface PreviewClient {
	/** One claim per recording; the worker is created lazily on the first claim that actually feeds. */
	claim(recordingId: string, onEvent: (event: PreviewEvent) => void): PreviewChannel;
	/** Terminates the warm worker and settles every outstanding claim. Idempotent. */
	destroy(): Promise<void>;
}

const DEFAULT_FLUSH_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

/** The entry as a URL: the thread is loaded by the runtime's ESM resolver, never by the host's loader. */
const WORKER_URL = new URL("./local-preview-worker.ts", import.meta.url);

type Timer = ReturnType<typeof setTimeout>;

interface ClaimState {
	recordingId: string;
	onEvent: (event: PreviewEvent) => void;
	/** `release()` ended this claim: no more events, feeds or protocol traffic for it. */
	released: boolean;
	/** The one `degraded` this claim may receive has been emitted. */
	degraded: boolean;
	/** Audio reached the worker, so releasing this claim leaves a segment for it to drain. */
	fedAudio: boolean;
	/**
	 * The segment this claim could still have open, and the last partial text forwarded for it.
	 *
	 * A commit advances the id past the segment it ended and clears the text; `text === null` means the
	 * open segment showed nothing yet. Tracking it here is what lets a failure close the segment with the
	 * words the caller is still rendering instead of an empty one.
	 */
	openSegmentId: number;
	openText: string | null;
}

interface PendingFlush {
	/** The claim waiting on this answer, or `null` for a maintenance flush that reports to nobody. */
	claim: ClaimState | null;
	requestId: number;
	settled: boolean;
	timer: Timer;
	resolve: () => void;
}

/**
 * Work received before `init` was answered, in call order.
 *
 * The worker drops audio that arrives before `ready`, and a recording starts before the ~650 ms model
 * load can finish, so the client holds the first seconds itself instead of losing them.
 */
type QueueEntry =
	| { kind: "feed"; claim: ClaimState; samples: Float32Array }
	| { kind: "flush"; claim: ClaimState; reason: FlushReason; pending: PendingFlush };

export function createPreviewClient(options: PreviewClientOptions): PreviewClient {
	const modelDir = options.previewModelDir;
	const flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
	const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
	const spawn = options.spawnWorker ?? ((url: URL) => new Worker(url));

	/** The warm worker, or `null` before the first feed and after any teardown. */
	let worker: PreviewWorkerLike | null = null;
	/** The worker answered `init`; queued work may be posted in order. */
	let ready = false;
	let idleTimer: Timer | null = null;
	let nextRequestId = 1;

	/** Claims that have not been released: the recordings the worker is being kept warm for. */
	const liveClaims = new Set<ClaimState>();
	const queue: QueueEntry[] = [];
	/** Posted flushes awaiting their `flushed`, by request id. */
	const pending = new Map<number, PendingFlush>();
	/**
	 * Maintenance flush ids whose drain must not reach a claim. Non-empty means "the worker is still
	 * producing the released recording's tail", which is also why no legitimate event can arrive: a feed
	 * posted later is processed after the maintenance flush's answer.
	 */
	const cleanupRequests = new Set<number>();
	/** Whose audio the worker is currently turning into partials and commits. */
	let eventClaim: ClaimState | null = null;

	function unref(timer: Timer): void {
		(timer as unknown as { unref?: () => void }).unref?.();
	}

	function describe(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	function clearIdleTimer(): void {
		if (idleTimer === null) return;
		clearTimeout(idleTimer);
		idleTimer = null;
	}

	/** Deliver to the claim, never throwing into the worker's message loop or a waiting flush. */
	function deliver(claim: ClaimState, event: PreviewEvent): void {
		if (claim.released) return;
		try {
			claim.onEvent(event);
		} catch {
			// The client's contract is "never throw to the caller"; a consumer's own throw is its bug and
			// must not escape into a worker message handler or reject the flush it is waiting on.
		}
	}

	/**
	 * Close the claim's open segment with a `commit`, carrying the last partial text it showed.
	 *
	 * This is what the spec's "empty commit" on a failed flush is for (§4.3): it ends the segment for good,
	 * so the next claim's first partial cannot extend text the user already saw, and it does so without
	 * losing anything — the text handed over is the text that was on screen, and the commit is that same
	 * text made immutable. With no partial ever forwarded the commit is empty, which a text join drops.
	 */
	function freezeClaim(claim: ClaimState): void {
		const text = claim.openText ?? "";
		claim.openText = null;
		deliver(claim, {
			kind: "commit",
			recordingId: claim.recordingId,
			segmentId: claim.openSegmentId,
			text,
		});
	}

	/** The one degradation a claim may receive. A later failure finds it already reported. */
	function degradeClaim(claim: ClaimState, detail: string): void {
		if (claim.released || claim.degraded) return;
		claim.degraded = true;
		// The commit lands first: a consumer that stops listening on `degraded` still has the text it was
		// rendering, now as an immutable segment instead of a tail a later claim could overwrite.
		freezeClaim(claim);
		deliver(claim, { kind: "degraded", recordingId: claim.recordingId, reason: "preview-worker-failed", detail });
	}

	function settle(pendingFlush: PendingFlush): void {
		if (pendingFlush.settled) return;
		pendingFlush.settled = true;
		clearTimeout(pendingFlush.timer);
		pending.delete(pendingFlush.requestId);
		// A settled maintenance flush is no longer gating stream events. On the normal path its
		// `flushed` answer already removed it; this covers the teardown paths where no answer will come.
		cleanupRequests.delete(pendingFlush.requestId);
		pendingFlush.resolve();
	}

	function settleAll(): void {
		for (const pendingFlush of [...pending.values()]) settle(pendingFlush);
	}

	function settleClaim(claim: ClaimState): void {
		for (const pendingFlush of [...pending.values()]) {
			if (pendingFlush.claim === claim) settle(pendingFlush);
		}
	}

	function startTimer(pendingFlush: PendingFlush): Timer {
		const timer = setTimeout(() => onFlushTimeout(pendingFlush), flushTimeoutMs);
		// A timer must never be the reason the host process stays alive.
		unref(timer);
		return timer;
	}

	function track(claim: ClaimState | null, resolve: () => void): PendingFlush {
		const pendingFlush: PendingFlush = {
			claim,
			requestId: nextRequestId++,
			settled: false,
			timer: undefined as unknown as Timer,
			resolve,
		};
		pendingFlush.timer = startTimer(pendingFlush);
		pending.set(pendingFlush.requestId, pendingFlush);
		return pendingFlush;
	}

	function post(message: WorkerRequest, transfer?: readonly Transferable[]): boolean {
		const current = worker;
		if (current === null) return false;
		try {
			current.postMessage(message, transfer);
			return true;
		} catch (error) {
			failWorker(`preview worker rejected a message: ${describe(error)}`);
			return false;
		}
	}

	function postFeed(claim: ClaimState, samples: Float32Array): void {
		claim.fedAudio = true;
		eventClaim = claim;
		post({ type: "feed", samples }, [samples.buffer as ArrayBuffer]);
	}

	function postFlush(pendingFlush: PendingFlush, reason: FlushReason): void {
		post({ type: "flush", reason, requestId: pendingFlush.requestId });
	}

	/** End the worker without touching claims: every caller owns what the loss means for them. */
	function terminateWorker(): void {
		const current = worker;
		worker = null;
		ready = false;
		cleanupRequests.clear();
		queue.length = 0;
		eventClaim = null;
		if (current === null) return;
		try {
			current.terminate();
		} catch {
			// A worker that cannot be terminated has already gone; there is nothing left to release.
		}
	}

	/**
	 * The worker is unusable: report it once per live claim and settle every pending flush now.
	 *
	 * This is the reason a `failed` message does not cost each waiting flush its timeout: the worker is
	 * gone, so its answer is never coming, and the final pass must not inherit that latency.
	 */
	function failWorker(detail: string): void {
		terminateWorker();
		clearIdleTimer();
		for (const claim of [...liveClaims]) degradeClaim(claim, detail);
		settleAll();
	}

	/** Arm the shutdown that stops a warm worker from holding ~290 MB forever with no recording. */
	function armIdleTimer(): void {
		clearIdleTimer();
		// A live claim owns the worker: an idle shutdown would destroy the recogniser mid-recording.
		if (liveClaims.size > 0 || worker === null) return;
		idleTimer = setTimeout(() => {
			idleTimer = null;
			// No claim is live, so no failure is anyone's to report: an idle shutdown is silent.
			terminateWorker();
			settleAll();
		}, idleTimeoutMs);
		unref(idleTimer);
	}

	function dropClaimOps(claim: ClaimState): void {
		for (let index = queue.length - 1; index >= 0; index--) {
			if (queue[index]?.claim === claim) queue.splice(index, 1);
		}
	}

	/**
	 * Drain whatever segment the released claim left open, as a flush that belongs to no claim.
	 *
	 * Only a claim that actually posted audio can have left one, and only a ready worker can be asked:
	 * audio still queued when the claim is released is dropped by `dropClaimOps`, so the worker never saw
	 * it and has nothing to drain.
	 */
	function requestCleanupFlush(): void {
		const pendingFlush = track(null, () => {});
		cleanupRequests.add(pendingFlush.requestId);
		postFlush(pendingFlush, "stop");
	}

	function endClaim(claim: ClaimState): void {
		if (claim.released) return;
		claim.released = true;
		liveClaims.delete(claim);
		dropClaimOps(claim);
		settleClaim(claim);
		if (eventClaim === claim) eventClaim = null;
		if (claim.fedAudio && ready && worker !== null) requestCleanupFlush();
		armIdleTimer();
	}

	function flushClaim(claim: ClaimState, reason: FlushReason): Promise<void> {
		if (claim.released || claim.degraded) return Promise.resolve();
		// No worker yet: this claim never fed audio, so there is no segment for anyone to end.
		if (worker === null) return Promise.resolve();

		let resolveFlush: () => void = () => {};
		const settled = new Promise<void>((resolve) => {
			resolveFlush = resolve;
		});
		const pendingFlush = track(claim, resolveFlush);
		if (ready) postFlush(pendingFlush, reason);
		else queue.push({ kind: "flush", claim, reason, pending: pendingFlush });
		return settled;
	}

	function onFlushTimeout(pendingFlush: PendingFlush): void {
		if (pendingFlush.settled) return;
		const detail = `preview flush timed out after ${flushTimeoutMs} ms`;
		// A maintenance flush has no claim: the recording it drained is over and must not be degraded
		// for a timeout nobody is waiting on.
		if (pendingFlush.claim !== null) degradeClaim(pendingFlush.claim, detail);
		// A worker that will not answer a flush cannot be reused: the segment it holds is stuck, and every
		// later flush would wait out the same timeout. Terminating also settles this pending flush.
		failWorker(detail);
	}

	function onReady(): void {
		ready = true;
		// Replay what the caller did before the handshake finished, in call order.
		while (queue.length > 0) {
			const entry = queue.shift() as QueueEntry;
			if (entry.kind === "feed") {
				if (entry.claim.released || entry.claim.degraded) continue;
				postFeed(entry.claim, entry.samples);
			} else if (!entry.pending.settled) {
				postFlush(entry.pending, entry.reason);
			}
		}
	}

	/** Whose event this is: `null` while a released recording's tail is still draining. */
	function streamTarget(): ClaimState | null {
		if (cleanupRequests.size > 0) return null;
		const claim = eventClaim;
		if (claim === null || claim.released || claim.degraded) return null;
		return claim;
	}

	function onPartial(message: { segmentId: number; revision: number; text: string }): void {
		const claim = streamTarget();
		if (claim === null) return;
		// Remember the tail as it is delivered: this is the text a failure has to freeze, not re-ask for.
		claim.openSegmentId = message.segmentId;
		claim.openText = message.text;
		deliver(claim, {
			kind: "partial",
			recordingId: claim.recordingId,
			segmentId: message.segmentId,
			revision: message.revision,
			text: message.text,
		});
	}

	function onCommit(message: { segmentId: number; text: string }): void {
		const claim = streamTarget();
		if (claim === null) return;
		// The committed segment is immutable now and nothing of it is left to freeze: the claim's open
		// segment becomes the next one, and a later failure therefore cannot re-commit its text.
		if (message.segmentId >= claim.openSegmentId) {
			claim.openSegmentId = message.segmentId + 1;
			claim.openText = null;
		}
		deliver(claim, {
			kind: "commit",
			recordingId: claim.recordingId,
			segmentId: message.segmentId,
			text: message.text,
		});
	}

	function handleMessage(message: unknown): void {
		if (!isWorkerResponse(message)) return;
		switch (message.type) {
			case "ready":
				onReady();
				return;
			case "partial":
				onPartial(message);
				return;
			case "commit":
				onCommit(message);
				return;
			case "flushed": {
				const pendingFlush = pending.get(message.requestId);
				// A late answer to a flush that already settled (timeout, release, destroy) has no owner.
				if (pendingFlush !== undefined) settle(pendingFlush);
				return;
			}
			case "failed":
				failWorker(message.message);
				return;
		}
	}

	function ensureWorker(): boolean {
		if (modelDir === null) return false;
		if (worker !== null) return true;

		let created: PreviewWorkerLike;
		try {
			created = spawn(WORKER_URL);
		} catch (error) {
			failWorker(`preview worker could not start: ${describe(error)}`);
			return false;
		}

		worker = created;
		ready = false;
		created.on("message", (message: unknown) => {
			// A message from a worker this client has already replaced belongs to no claim.
			if (worker !== created) return;
			handleMessage(message);
		});
		created.on("error", (error: unknown) => {
			if (worker !== created) return;
			failWorker(describe(error));
		});
		created.on("exit", (code: unknown) => {
			// Only a worker that ended itself is news: every deliberate teardown nulls `worker` first, so
			// its exit lands on a stale instance and is ignored.
			if (worker !== created) return;
			failWorker(`preview worker exited with code ${String(code)}`);
		});
		post({ type: "init", modelDir });
		return worker !== null;
	}

	function feedClaim(claim: ClaimState, chunk: Buffer): void {
		if (claim.released || claim.degraded) return;
		// Shorter than one sample is not audio: it must not spawn a worker or open a segment.
		if (chunk.length < 2) return;

		let samples: Float32Array;
		try {
			samples = pcmToFloat32(chunk);
		} catch (error) {
			// Feeding is fire-and-forget, so a conversion failure's only channel is the degradation.
			degradeClaim(claim, `preview audio could not be converted: ${describe(error)}`);
			return;
		}

		if (worker === null && !ensureWorker()) return;
		if (ready) postFeed(claim, samples);
		else queue.push({ kind: "feed", claim, samples });
	}

	function destroyClient(): Promise<void> {
		clearIdleTimer();
		terminateWorker();
		settleAll();
		// Destroying the worker retires every recording still using it: a claim must not be able to feed
		// a worker that no longer exists, and must not wait on a flush that can never be answered.
		for (const claim of [...liveClaims]) {
			claim.released = true;
			liveClaims.delete(claim);
		}
		return Promise.resolve();
	}

	function claim(recordingId: string, onEvent: (event: PreviewEvent) => void): PreviewChannel {
		const state: ClaimState = {
			recordingId,
			onEvent,
			released: false,
			degraded: false,
			fedAudio: false,
			openSegmentId: 0,
			openText: null,
		};

		if (modelDir === null) {
			// Without a model there is no preview at all: not a degradation, and not worth a worker.
			return {
				recordingId,
				feed: () => {},
				flush: () => Promise.resolve(),
				release: () => {},
				destroy: destroyClient,
			};
		}

		liveClaims.add(state);
		// A live claim keeps the worker alive: an idle timeout firing mid-recording would destroy the
		// recogniser the recording is using.
		clearIdleTimer();

		return {
			recordingId,
			feed(chunk: Buffer): void {
				try {
					feedClaim(state, chunk);
				} catch (error) {
					degradeClaim(state, describe(error));
				}
			},
			flush(reason: FlushReason): Promise<void> {
				try {
					return flushClaim(state, reason);
				} catch (error) {
					// `flush()` never rejects, so a client-side fault still has to end as a resolved promise.
					degradeClaim(state, describe(error));
					return Promise.resolve();
				}
			},
			release(): void {
				endClaim(state);
			},
			destroy(): Promise<void> {
				return destroyClient();
			},
		};
	}

	return { claim, destroy: destroyClient };
}

/** The response types the protocol defines; anything else is not this worker's and is ignored. */
const RESPONSE_TYPES = new Set<string>(["ready", "partial", "commit", "flushed", "failed"]);

function isWorkerResponse(value: unknown): value is WorkerResponse {
	if (typeof value !== "object" || value === null) return false;
	return RESPONSE_TYPES.has(String((value as { type?: unknown }).type));
}

/**
 * Convert the capture child's 16-bit signed LE PCM to the float samples the protocol carries.
 *
 * The mirror of `preview-stream`'s own conversion, and the same byte-offset caveat: a pooled Buffer can
 * start at an odd byte offset, where an `Int16Array` view throws, so the per-sample read is that
 * fallback rather than the fast path. A trailing odd byte is not a sample and is dropped.
 */
function pcmToFloat32(pcm: Buffer): Float32Array {
	const sampleCount = Math.floor(pcm.length / 2);
	const samples = new Float32Array(sampleCount);
	if ((pcm.byteOffset & 1) === 0) {
		const int16 = new Int16Array(pcm.buffer, pcm.byteOffset, sampleCount);
		for (let index = 0; index < sampleCount; index++) samples[index] = int16[index] / 32768;
		return samples;
	}
	for (let index = 0; index < sampleCount; index++) samples[index] = pcm.readInt16LE(index * 2) / 32768;
	return samples;
}
