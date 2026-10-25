/**
 * A scripted stand-in for the preview worker, used only by `tests/preview-worker-client.test.ts`.
 *
 * Spec: docs/superpowers/specs/2026-10-22-local-streaming-preview-design.md §5.2/§5.3. The client's
 * interesting paths are the protocol's edges — a flush that is never answered, a worker that reports
 * `failed` — and none of them needs a model, the native addon or a decode. This worker speaks Task 7's
 * protocol verbatim and is spawned by `worker_threads` exactly like the real entry, so the client's
 * handshake, buffering and settlement paths are exercised against a real thread.
 *
 * Each `feed` produces a partial and each answered flush commits the open segment, so a test can read
 * the segment's history back out of the text: `p<segment>:<feed>:<samples>` for a partial and
 * `s<segment>:<feed>` for a commit. The segment id only advances on a commit, which is what makes an
 * abandoned segment visible to the next recording.
 *
 * `workerData.mode` selects the script:
 * - `stream` (default): the well-behaved worker.
 * - `silent-flush`: answers `init`, emits partials, swallows every `flush`.
 * - `fail-second-flush`: swallows the first flush, then reports `failed` and exits.
 */

import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import type { WorkerRequest, WorkerResponse } from "../../extensions/voice/local-preview-worker";

export type FakePreviewWorkerMode = "stream" | "silent-flush" | "fail-second-flush";

const mode: FakePreviewWorkerMode = (workerData as { mode?: FakePreviewWorkerMode } | null)?.mode ?? "stream";

const port = parentPort;
// Importing this module for its `mode` type in the main thread must not attach a listener; only a
// worker thread has a port.
if (port !== null) script(port);

function script(port: MessagePort): void {
	let segmentId = 0;
	let feedsInSegment = 0;
	let flushes = 0;

	function send(response: WorkerResponse): void {
		port.postMessage(response);
	}

	port.on("message", (request: WorkerRequest) => {
		switch (request.type) {
			case "init":
				send({ type: "ready" });
				break;
			case "feed":
				feedsInSegment += 1;
				send({
					type: "partial",
					segmentId,
					revision: feedsInSegment,
					text: `p${segmentId}:${feedsInSegment}:${request.samples.length}`,
				});
				break;
			case "flush":
				flushes += 1;
				if (mode === "silent-flush") break;
				if (mode === "fail-second-flush" && flushes === 1) break;
				if (mode === "fail-second-flush") {
					// The real worker posts its one failure and ends the thread; a client that waits for the
					// flush timeout instead of settling on this message is the bug this mode is here to catch.
					send({ type: "failed", message: "scripted flush failure" });
					process.exit(0);
				}
				// A flush of a segment that was never fed is answered without a commit, like the real worker.
				if (feedsInSegment > 0) {
					send({ type: "commit", segmentId, text: `s${segmentId}:${feedsInSegment}` });
					segmentId += 1;
					feedsInSegment = 0;
				}
				send({ type: "flushed", requestId: request.requestId });
				break;
			case "dispose":
				process.exit(0);
		}
	});
}
