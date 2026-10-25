import { describe, expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import type { WorkerRequest, WorkerResponse } from "../extensions/voice/local-preview-worker";

/**
 * The preview worker entry, spawned for real.
 *
 * Spec: docs/superpowers/specs/2026-10-22-local-streaming-preview-design.md §5.2/§5.3. The entry owns
 * the addon (CommonJS, loaded through `createRequire`) and the recogniser, so the only thing a client
 * can observe is the protocol — and the failures a client cannot recover from are the ones asserted
 * here: a model that will not load must cost exactly one `failed` message and a clean exit, never an
 * uncaught exception, and every `flush` must be answered so a pending flush never hangs.
 *
 * Only the last test needs a real streaming model; it is skipped unless VOICEKIT_PREVIEW_MODEL_DIR
 * points at one, so CI (which has no model and never downloads one) still runs the rest.
 */

const SAMPLE_RATE = 16_000;
const WORKER_URL = new URL("../extensions/voice/local-preview-worker.ts", import.meta.url);

/** How long a spawn is given before it counts as hung (model load is ~650 ms on a warm cache). */
const SPAWN_TIMEOUT_MS = 30_000;
/** The real model load plus a segment drain, with room for a cold disk. */
const MODEL_TIMEOUT_MS = 60_000;

interface Harness {
	worker: Worker;
	messages: WorkerResponse[];
	/** Uncaught exceptions and unhandled rejections raised by the worker thread. */
	errors: string[];
	/** Resolves with the first message matching `match`; rejects when the timeout expires. */
	waitFor(match: (message: WorkerResponse) => boolean, timeoutMs?: number): Promise<WorkerResponse>;
	/** Resolves with the worker's exit code, or `null` when it had to be terminated. */
	exit(timeoutMs?: number): Promise<number | null>;
}

function spawnPreviewWorker(): Harness {
	const worker = new Worker(WORKER_URL);
	const messages: WorkerResponse[] = [];
	const errors: string[] = [];
	const waiters: { match: (message: WorkerResponse) => boolean; resolve: (message: WorkerResponse) => void }[] = [];

	worker.on("message", (message: WorkerResponse) => {
		messages.push(message);
		for (const waiter of [...waiters]) {
			if (!waiter.match(message)) continue;
			waiters.splice(waiters.indexOf(waiter), 1);
			waiter.resolve(message);
		}
	});
	worker.on("error", (error: Error) => errors.push(error.message));

	const exited = new Promise<number>((resolve) => worker.on("exit", (code: number) => resolve(code)));

	return {
		worker,
		messages,
		errors,
		waitFor(match, timeoutMs = SPAWN_TIMEOUT_MS) {
			const seen = messages.find(match);
			if (seen) return Promise.resolve(seen);
			return new Promise<WorkerResponse>((resolve, reject) => {
				const timer = setTimeout(() => {
					reject(new Error(`no matching message within ${timeoutMs} ms; got ${JSON.stringify(messages)}`));
				}, timeoutMs);
				waiters.push({
					match,
					resolve: (message) => {
						clearTimeout(timer);
						resolve(message);
					},
				});
			});
		},
		async exit(timeoutMs = SPAWN_TIMEOUT_MS) {
			const code = await new Promise<number | null>((resolve) => {
				const timer = setTimeout(() => {
					void worker.terminate();
					resolve(null);
				}, timeoutMs);
				void exited.then((exitCode) => {
					clearTimeout(timer);
					resolve(exitCode);
				});
			});
			return code;
		},
	};
}

describe("local preview worker", () => {
	test(
		"a missing model reports a structured failure instead of crashing",
		async () => {
			const harness = spawnPreviewWorker();
			harness.worker.postMessage({ type: "init", modelDir: "/nonexistent/preview-model" } satisfies WorkerRequest);

			const failure = await harness.waitFor((message) => message.type === "failed");
			const code = await harness.exit();

			// The detail reaches the debug channel, so it must name what could not be used: sherpa's own error
			// for an unreadable path is "Please check your config!", which names nothing. Exactly one message:
			// a failure is not followed by a `ready` for a recogniser that does not exist.
			expect(failure).toEqual({
				type: "failed",
				message: expect.stringContaining("/nonexistent/preview-model"),
			});
			expect(harness.messages).toHaveLength(1);
			// A crash is an uncaught exception or an unhandled rejection, not an exit code: Bun reports code 0
			// even when the worker threw, so the absence of an 'error' event is the real signal.
			expect(harness.errors).toEqual([]);
			expect(code).toBe(0);
		},
		SPAWN_TIMEOUT_MS + 5_000
	);

	test(
		"every flush is answered, and dispose ends the thread without an error",
		async () => {
			const harness = spawnPreviewWorker();
			// Neither message has a recogniser behind it yet. The `feed` is dropped on purpose — audio that
			// arrives before `ready` cannot be accepted, which is why the client awaits `ready` before it
			// feeds — while the `flush` must still be answered, because a pending flush would otherwise wait
			// out the client's timeout on a segment that never opened.
			harness.worker.postMessage({ type: "feed", samples: new Float32Array(SAMPLE_RATE / 10) } satisfies WorkerRequest);
			harness.worker.postMessage({ type: "flush", reason: "stop", requestId: 41 } satisfies WorkerRequest);

			expect(await harness.waitFor((message) => message.type === "flushed")).toEqual({
				type: "flushed",
				requestId: 41,
			});
			expect(harness.messages.filter((message) => message.type === "commit")).toEqual([]);

			harness.worker.postMessage({ type: "dispose" } satisfies WorkerRequest);
			expect(await harness.exit()).toBe(0);
			expect(harness.errors).toEqual([]);
		},
		SPAWN_TIMEOUT_MS + 5_000
	);

	const modelDir = process.env.VOICEKIT_PREVIEW_MODEL_DIR;

	test.skipIf(!modelDir)(
		"feeds one second of silence and flushes",
		async () => {
			const harness = spawnPreviewWorker();
			harness.worker.postMessage({ type: "init", modelDir: modelDir! } satisfies WorkerRequest);
			expect(await harness.waitFor((message) => message.type === "ready" || message.type === "failed")).toEqual({
				type: "ready",
			});

			// One second of silence in 100 ms chunks — the capture child's cadence. Silence cannot produce
			// words, so the drain's commit is the empty one the protocol still has to deliver: a flush that
			// never answered would stall the client for its full timeout on every silent recording.
			const chunk = new Float32Array(SAMPLE_RATE / 10);
			for (let index = 0; index < 10; index++) {
				harness.worker.postMessage({ type: "feed", samples: chunk } satisfies WorkerRequest);
			}
			harness.worker.postMessage({ type: "flush", reason: "stop", requestId: 7 } satisfies WorkerRequest);

			expect(await harness.waitFor((message) => message.type === "flushed", MODEL_TIMEOUT_MS)).toEqual({
				type: "flushed",
				requestId: 7,
			});
			expect(harness.messages.filter((message) => message.type === "commit")).toEqual([
				{ type: "commit", segmentId: 0, text: "" },
			]);

			// The worker stays warm: a flush ends the segment, not the recording. The next claim's audio
			// reaches a fresh online stream on the same recogniser, and its flush answers and commits again.
			for (let index = 0; index < 10; index++) {
				harness.worker.postMessage({ type: "feed", samples: chunk } satisfies WorkerRequest);
			}
			harness.worker.postMessage({ type: "flush", reason: "stop", requestId: 8 } satisfies WorkerRequest);

			expect(await harness.waitFor((message) => message.type === "flushed" && message.requestId === 8)).toEqual({
				type: "flushed",
				requestId: 8,
			});
			expect(harness.messages.filter((message) => message.type === "commit")).toEqual([
				{ type: "commit", segmentId: 0, text: "" },
				{ type: "commit", segmentId: 1, text: "" },
			]);
			expect(harness.errors).toEqual([]);

			harness.worker.postMessage({ type: "dispose" } satisfies WorkerRequest);
			expect(await harness.exit()).toBe(0);
		},
		MODEL_TIMEOUT_MS + 10_000
	);
});
