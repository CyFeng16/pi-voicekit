import { afterEach, describe, expect, test } from "bun:test";
import { Worker, type Transferable } from "node:worker_threads";
import {
	createPreviewClient,
	type PreviewClient,
	type PreviewClientOptions,
	type PreviewEvent,
	type PreviewWorkerLike,
} from "../extensions/voice/preview-worker-client";
import type { FakePreviewWorkerMode } from "./fixtures/fake-preview-worker";

/**
 * The preview worker client, against a scripted worker.
 *
 * Spec: docs/superpowers/specs/2026-10-22-local-streaming-preview-design.md §4.3, §5.5, §6.3.
 *
 * Every property here is a lifecycle guarantee the entrypoint depends on: the worker outlives the
 * recording (one claim per recording, released at the end), a flush always settles, and a worker that
 * reports `failed` costs one degradation and no timeout wait. The fixture worker is spawned from its
 * `.ts` entry through `worker_threads`, so the handshake and the message ordering are real; only the
 * decode is scripted.
 */

const FIXTURE_URL = new URL("./fixtures/fake-preview-worker.ts", import.meta.url);
/** The client must ask for the real entry; a test substitutes the URL, never the contract. */
// The client resolves its entry through `resolveWorkerEntry`: a published package ships a
// bundled `.js` (Node cannot strip types under node_modules), a checkout uses the `.ts` source.

interface Spawner {
	spawn: (url: URL) => PreviewWorkerLike;
	spawned: number;
	terminated: number;
	urls: URL[];
}

/** A spawn function that counts what the client asked for, and runs the fixture instead. */
function spawnerFor(mode: FakePreviewWorkerMode): Spawner {
	const spawner = {
		spawned: 0,
		terminated: 0,
		urls: [] as URL[],
		spawn(url: URL): PreviewWorkerLike {
			spawner.urls.push(url);
			spawner.spawned += 1;
			const worker = new Worker(FIXTURE_URL, { workerData: { mode } });
			return {
				postMessage(value: unknown, transfer?: readonly Transferable[]) {
					worker.postMessage(value, transfer);
				},
				on(event: string, listener: (...args: unknown[]) => void) {
					worker.on(event, listener);
				},
				terminate() {
					spawner.terminated += 1;
					void worker.terminate();
				},
			};
		},
	};
	return spawner;
}

const clients: PreviewClient[] = [];

function makeClient(spawner: Spawner, options: Partial<PreviewClientOptions> = {}): PreviewClient {
	const client = createPreviewClient({
		previewModelDir: "/fake/preview-model",
		spawnWorker: spawner.spawn,
		// Long enough that a working flush never trips it; the timeout test sets its own.
		flushTimeoutMs: 2_000,
		idleTimeoutMs: 60_000,
		...options,
	});
	clients.push(client);
	return client;
}

// A worker thread keeps the process alive, so every test's client is torn down even when an assertion
// threw before its own `destroy()`.
afterEach(async () => {
	for (const client of clients.splice(0)) await client.destroy();
});

/** A constant-amplitude PCM16LE chunk of `samples` samples, the capture child's wire format. */
function pcm16(samples: number): Buffer {
	const chunk = Buffer.alloc(samples * 2);
	for (let index = 0; index < samples; index++) chunk.writeInt16LE(1_000, index * 2);
	return chunk;
}

/** The same chunk at an odd byte offset, which is where a pooled Buffer can put it. */
function oddOffsetPcm16(samples: number): Buffer {
	const backing = Buffer.alloc(samples * 2 + 1);
	const chunk = backing.subarray(1);
	for (let index = 0; index < samples; index++) chunk.writeInt16LE(1_000, index * 2);
	return chunk;
}

/** Wait for an observable the worker produces, so a test never races the handshake. */
async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error("the expected observable never appeared");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("preview worker client", () => {
	test("a flush that never answers resolves after the timeout and reports degradation", async () => {
		const spawner = spawnerFor("silent-flush");
		const client = makeClient(spawner, { flushTimeoutMs: 120 });
		const events: PreviewEvent[] = [];
		const channel = client.claim("r1", (event) => events.push(event));

		channel.feed(pcm16(160));
		// The partial is in hand before the flush is posted, so the tail the client has to freeze is known.
		await until(() => events.some((event) => event.kind === "partial"));
		const startedAt = Date.now();
		await channel.flush("stop");
		const elapsed = Date.now() - startedAt;

		// The caller waited the timeout and not a millisecond more: the promise resolves, it never rejects.
		expect(elapsed).toBeGreaterThanOrEqual(100);
		expect(elapsed).toBeLessThan(1_000);
		// The segment closes with the text the user is still looking at, and only then is it degraded: a
		// consumer that stops listening on `degraded` must not lose the words it was rendering.
		expect(events.map((event) => event.kind)).toEqual(["partial", "commit", "degraded"]);
		expect(events[1]).toEqual({ kind: "commit", recordingId: "r1", segmentId: 0, text: "p0:1:160" });
		expect(events[2]).toEqual({
			kind: "degraded",
			recordingId: "r1",
			reason: "preview-worker-failed",
			detail: expect.any(String),
		});
		// One failed flush is exactly one commit and exactly one degradation.
		expect(events.filter((event) => event.kind === "commit")).toHaveLength(1);
		expect(events.filter((event) => event.kind === "degraded")).toHaveLength(1);
		// A worker that will not answer a flush cannot be reused, so it is not kept warm either.
		expect(spawner.terminated).toBe(1);

		// The claim is degraded for good: later flushes and feeds report nothing new.
		const settled = events.length;
		await channel.flush("stop");
		channel.feed(pcm16(160));
		expect(events).toHaveLength(settled);
	}, 10_000);

	test("a timed-out flush with no partial commits empty text before it degrades", async () => {
		const spawner = spawnerFor("silent");
		const client = makeClient(spawner, { flushTimeoutMs: 120 });
		const events: PreviewEvent[] = [];
		const channel = client.claim("r1", (event) => events.push(event));

		// This worker never produces a partial, so there is no tail to freeze; the segment still closes.
		channel.feed(pcm16(160));
		await channel.flush("stop");

		expect(events).toEqual([
			{ kind: "commit", recordingId: "r1", segmentId: 0, text: "" },
			{ kind: "degraded", recordingId: "r1", reason: "preview-worker-failed", detail: expect.any(String) },
		]);
	}, 10_000);

	test("two consecutive claims reuse one worker; release never terminates it", async () => {
		const spawner = spawnerFor("stream");
		const client = makeClient(spawner);

		const firstEvents: PreviewEvent[] = [];
		const first = client.claim("r1", (event) => firstEvents.push(event));
		first.feed(pcm16(160));
		await first.flush("pause");
		first.release();

		const secondEvents: PreviewEvent[] = [];
		const second = client.claim("r2", (event) => secondEvents.push(event));
		second.feed(pcm16(160));
		await second.flush("stop");

		// The recogniser costs ~650 ms to build, so the second recording must not build another one.
		expect(spawner.spawned).toBe(1);
		expect(spawner.terminated).toBe(0);
		// The client must reach the real entry, never the fixture. Which entry that is depends on
		// packaging — `.js` in an installed tree, `.ts` in a checkout — and another test builds the
		// bundles concurrently, so the extension is deliberately not pinned here.
		expect(spawner.urls).toHaveLength(1);
		expect(spawner.urls[0].pathname).toMatch(/\/extensions\/voice\/local-preview-worker\.(js|ts)$/);
		// One worker produced both recordings, and each claim hears only its own.
		expect(firstEvents.every((event) => event.recordingId === "r1")).toBe(true);
		expect(secondEvents.every((event) => event.recordingId === "r2")).toBe(true);
		expect(firstEvents.filter((event) => event.kind === "commit")).toHaveLength(1);
		expect(secondEvents.filter((event) => event.kind === "commit")).toHaveLength(1);
		second.release();
	});

	test("release keeps the worker warm, destroy terminates it", async () => {
		const spawner = spawnerFor("stream");
		const client = makeClient(spawner);

		const channel = client.claim("r1", () => {});
		channel.feed(pcm16(160));
		await channel.flush("stop");
		channel.release();

		// Normal completion releases the claim and leaves the worker up for the next dictation.
		expect(spawner.spawned).toBe(1);
		expect(spawner.terminated).toBe(0);

		await client.destroy();
		expect(spawner.terminated).toBe(1);
		// Idempotent: a second destroy neither terminates twice nor throws.
		await client.destroy();
		expect(spawner.terminated).toBe(1);
		// The claim was retired by destroy; releasing it afterwards is a no-op, not a second teardown.
		channel.release();
		expect(spawner.terminated).toBe(1);
	});

	test("an idle worker is shut down after the idle timeout", async () => {
		const spawner = spawnerFor("stream");
		const client = makeClient(spawner, { idleTimeoutMs: 60 });

		const channel = client.claim("r1", () => {});
		channel.feed(pcm16(160));
		await channel.flush("stop");
		channel.release();

		// Release alone never terminates; the idle timer is what eventually gives the model's memory back.
		expect(spawner.terminated).toBe(0);
		await until(() => spawner.terminated === 1, 1_000);
	});

	test("destroy settles a pending flush instead of stranding it", async () => {
		const spawner = spawnerFor("silent-flush");
		const client = makeClient(spawner, { flushTimeoutMs: 5_000 });
		const events: PreviewEvent[] = [];
		const channel = client.claim("r1", (event) => events.push(event));

		channel.feed(pcm16(160));
		// The partial proves the worker is warm, so the flush below is actually posted, not queued.
		await until(() => events.some((event) => event.kind === "partial"));
		const pendingFlush = channel.flush("stop");
		await new Promise((resolve) => setTimeout(resolve, 20));

		await client.destroy();
		await pendingFlush;

		// An intentional teardown is not a degradation, and the 5 s timeout was never waited out.
		expect(events.filter((event) => event.kind === "degraded")).toEqual([]);
		// Nothing is frozen either: an abandoned recording is dropped, not closed off.
		expect(events.filter((event) => event.kind === "commit")).toEqual([]);
		expect(spawner.terminated).toBe(1);
	});

	test("a null modelDir yields a channel that never spawns and never reports degradation", async () => {
		const spawner = spawnerFor("stream");
		const client = makeClient(spawner, { previewModelDir: null });
		const events: PreviewEvent[] = [];
		const channel = client.claim("r1", (event) => events.push(event));

		channel.feed(pcm16(160));
		await channel.flush("stop");
		channel.release();
		await channel.destroy();

		// A missing model is a normal steady state (§6.2), not a degradation: no event at all.
		expect(spawner.spawned).toBe(0);
		expect(events).toEqual([]);
	});

	test("a failed message settles every pending flush at once", async () => {
		const spawner = spawnerFor("fail-second-flush");
		const client = makeClient(spawner);
		const events: PreviewEvent[] = [];
		const channel = client.claim("r1", (event) => events.push(event));
		channel.feed(pcm16(160));

		// Two flushes are in flight when the worker reports the failure; both must settle now, not at 2 s.
		const pause = channel.flush("pause");
		const stop = channel.flush("stop");
		const startedAt = Date.now();
		await Promise.all([pause, stop]);
		const elapsed = Date.now() - startedAt;

		expect(elapsed).toBeLessThan(1_000);
		expect(events.filter((event) => event.kind === "degraded")).toEqual([
			{
				kind: "degraded",
				recordingId: "r1",
				reason: "preview-worker-failed",
				detail: "scripted flush failure",
			},
		]);
		// One worker failure is one degradation, however many flushes were waiting on it.
		expect(events.filter((event) => event.kind === "degraded")).toHaveLength(1);
		// A reported failure closes the segment the same way a timeout does, and likewise before the
		// degradation, so the `degraded`-message path cannot lose the tail either.
		expect(events.map((event) => event.kind)).toEqual(["partial", "commit", "degraded"]);
		expect(events.filter((event) => event.kind === "commit")).toEqual([
			{ kind: "commit", recordingId: "r1", segmentId: 0, text: "p0:1:160" },
		]);
	});

	test("partials and commits reach the claim, converted and in order", async () => {
		const spawner = spawnerFor("stream");
		const client = makeClient(spawner);
		const events: PreviewEvent[] = [];
		const channel = client.claim("r1", (event) => events.push(event));

		// Both feeds happen before the worker answers `init`: the client has to buffer them, because the
		// worker drops audio that arrives before `ready` and the first seconds of a preview would be lost.
		channel.feed(pcm16(160));
		channel.feed(oddOffsetPcm16(4));
		await channel.flush("stop");

		expect(events.map((event) => event.kind)).toEqual(["partial", "partial", "commit"]);
		// The sample count is the fixture's echo of what the client sent: PCM16LE in, float samples out,
		// including the odd-offset buffer a pooled Buffer can hand over.
		expect(events[0]).toMatchObject({ segmentId: 0, revision: 1, text: "p0:1:160" });
		expect(events[1]).toMatchObject({ segmentId: 0, revision: 2, text: "p0:2:4" });
		expect(events[2]).toMatchObject({ segmentId: 0, text: "s0:2" });
		expect(events.every((event) => event.recordingId === "r1")).toBe(true);
	});

	test("a recording released without a final flush does not leak into the next claim", async () => {
		const spawner = spawnerFor("stream");
		const client = makeClient(spawner);

		const firstEvents: PreviewEvent[] = [];
		const first = client.claim("r1", (event) => firstEvents.push(event));
		first.feed(pcm16(160));
		// The abort path releases mid-segment, so the worker still holds an open segment of this recording.
		await until(() => firstEvents.some((event) => event.kind === "partial"));
		first.release();

		const secondEvents: PreviewEvent[] = [];
		const second = client.claim("r2", (event) => secondEvents.push(event));
		second.feed(pcm16(160));
		second.feed(pcm16(160));
		await second.flush("stop");

		// The abandoned tail is drained into the released claim, whose events go nowhere: the next
		// recording opens a fresh segment and hears only its own two chunks.
		expect(secondEvents.filter((event) => event.kind === "commit")).toEqual([
			{ kind: "commit", recordingId: "r2", segmentId: 1, text: "s1:2" },
		]);
		expect(secondEvents.some((event) => event.text?.startsWith("s0:"))).toBe(false);
		expect(firstEvents.filter((event) => event.kind === "commit")).toEqual([]);
		second.release();
	});
});
