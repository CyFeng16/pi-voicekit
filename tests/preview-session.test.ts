import { describe, expect, test } from "bun:test";
import { createPreviewSession, type PreviewSessionHost } from "../extensions/voice/preview-session";
import type {
	DegradeReason,
	FlushReason,
	PreviewChannel,
	PreviewEvent,
} from "../extensions/voice/preview-worker-client";

/**
 * One recording's preview session, against a scripted channel and a scripted host.
 *
 * Spec: docs/superpowers/specs/2026-10-22-local-streaming-preview-design.md §4.3 (the event rules),
 * §5.2 (panel lifecycle), §5.1 (abort writes nothing).
 *
 * The properties pinned here are the ones no other module can hold: a retired recording's late events
 * must never reach the next one, a degradation is one fact about the recording rather than one notice
 * per event, and the session is the only owner of the panel's unmount (the entrypoint used to unmount
 * a second time, which is why that ownership moved here). The fake channel answers `flush()` with
 * whatever the test tells it to emit while the drain runs, because that is the window in which the
 * last segment's commit and a mid-drain worker failure actually arrive.
 */

const RECORDING = "rec-1";

interface FakeChannel extends PreviewChannel {
	fed: Buffer[];
	flushes: FlushReason[];
	released: number;
	destroyed: number;
	/** What the worker emits while the stop flush drains; the test sets this. */
	onFlush: (() => void) | null;
	/** When set, the stop flush waits for it, so a test can act inside the drain window. */
	flushGate: Promise<void> | null;
	/** Set to make the stop flush reject, as only a channel that broke its contract would. */
	flushError: Error | null;
}

function fakeChannel(recordingId = RECORDING): FakeChannel {
	const channel: FakeChannel = {
		recordingId,
		fed: [],
		flushes: [],
		released: 0,
		destroyed: 0,
		onFlush: null,
		flushGate: null,
		flushError: null,
		feed(chunk: Buffer): void {
			channel.fed.push(chunk);
		},
		async flush(reason: FlushReason): Promise<void> {
			channel.flushes.push(reason);
			channel.onFlush?.();
			if (channel.flushGate !== null) await channel.flushGate;
			if (channel.flushError !== null) throw channel.flushError;
		},
		release(): void {
			channel.released += 1;
		},
		async destroy(): Promise<void> {
			channel.destroyed += 1;
		},
	};
	return channel;
}

interface FakeHost extends PreviewSessionHost {
	mounts: number;
	unmounts: number;
	getText: (() => string) | null;
	degradations: { reason: DegradeReason; detail?: string }[];
}

function fakeHost(): FakeHost {
	const host: FakeHost = {
		mounts: 0,
		unmounts: 0,
		getText: null,
		degradations: [],
		mountPanel(getText: () => string): void {
			host.mounts += 1;
			host.getText = getText;
		},
		unmountPanel(): void {
			host.unmounts += 1;
		},
		onDegraded(reason: DegradeReason, detail?: string): void {
			host.degradations.push({ reason, detail });
		},
	};
	return host;
}

function partial(segmentId: number, revision: number, text: string, recordingId = RECORDING): PreviewEvent {
	return { kind: "partial", recordingId, segmentId, revision, text };
}

function commit(segmentId: number, text: string, recordingId = RECORDING): PreviewEvent {
	return { kind: "commit", recordingId, segmentId, text };
}

function degraded(reason: DegradeReason, detail?: string, recordingId = RECORDING): PreviewEvent {
	return { kind: "degraded", recordingId, reason, detail };
}

describe("preview session — one recording, one set of events", () => {
	test("events for another recording, or after the terminal, are ignored", async () => {
		const channel = fakeChannel();
		const host = fakeHost();
		const session = createPreviewSession(channel, host);

		// The id comes from the claim; a session never mints one, because the next recording's id has to
		// differ from this one for the retired events to be droppable at all.
		expect(session.recordingId).toBe(RECORDING);

		session.handleEvent(partial(0, 1, "other", "rec-2"));
		session.handleEvent(commit(0, "other", "rec-2"));
		session.handleEvent(degraded("preview-worker-failed", undefined, "rec-2"));
		expect(session.text).toBe("");
		expect(session.degraded).toBeNull();
		// Another recording's events must not even mount this recording's panel.
		expect(host.mounts).toBe(0);

		// Its own events still arrive.
		session.handleEvent(partial(0, 1, "你好"));

		await session.finish();

		// After the terminal every event is dropped, including one that carries this recording's own id:
		// that is what keeps a retired recording's late commit out of the next recording's panel.
		session.handleEvent(partial(0, 2, "late"));
		session.handleEvent(commit(1, "late"));
		session.handleEvent(degraded("preview-decode-failed"));
		expect(session.text).toBe("你好");
		expect(session.degraded).toBeNull();

		// Audio offered after the terminal is not the channel's business either.
		session.feed(Buffer.alloc(4));
		expect(channel.fed).toHaveLength(0);
	});

	test("degraded is recorded, not notified per event", () => {
		const channel = fakeChannel();
		const host = fakeHost();
		const session = createPreviewSession(channel, host);

		expect(session.degraded).toBeNull();

		session.handleEvent(degraded("preview-worker-failed", "worker exited with code 1"));
		session.handleEvent(degraded("preview-decode-failed", "recogniser threw"));

		// One reason describes the recording. The second degradation cannot rewrite the first: the
		// notice the user reads is folded from this one field.
		expect(session.degraded).toBe("preview-worker-failed");
		// The host hears it once, with the detail of the event that caused it — not once per event, and
		// not a second notice for a recording the entrypoint will already report on.
		expect(host.degradations).toEqual([{ reason: "preview-worker-failed", detail: "worker exited with code 1" }]);
		// A degradation carries no words, so it does not mount an empty widget above the editor.
		expect(host.mounts).toBe(0);
	});

	test("abort with zero audio destroys the worker; with audio it releases it", async () => {
		const quietChannel = fakeChannel();
		const quietHost = fakeHost();
		const quiet = createPreviewSession(quietChannel, quietHost);
		quiet.abort();
		await Promise.resolve();
		expect(quietChannel.destroyed).toBe(1);
		expect(quietChannel.released).toBe(0);
		// No audio means no segment to drain, so there is nothing to release the worker for.
		expect(quietHost.unmounts).toBe(0);

		const loudChannel = fakeChannel();
		const loud = createPreviewSession(loudChannel, fakeHost());
		loud.feed(Buffer.alloc(320)); // 160 samples at 16 kHz: the claim has a segment to drain
		expect(loudChannel.fed).toHaveLength(1);
		loud.abort();
		expect(loudChannel.released).toBe(1);
		expect(loudChannel.destroyed).toBe(0);

		// A chunk shorter than one sample never reaches the worker (the channel's own rule), so it is not
		// audio: the abort still terminates instead of releasing a claim that never spoke.
		const sliverChannel = fakeChannel();
		const sliver = createPreviewSession(sliverChannel, fakeHost());
		sliver.feed(Buffer.from([0x01]));
		sliver.abort();
		await Promise.resolve();
		expect(sliverChannel.destroyed).toBe(1);
		expect(sliverChannel.released).toBe(0);
	});
});

test("capture tail is fed throughout finalizing, even after the stop drain settles", async () => {
	const channel = fakeChannel();
	const session = createPreviewSession(channel, fakeHost());
	const first = Buffer.from([1, 0]);
	const tail = Buffer.from([2, 0]);
	session.feed(first);
	await session.drain();
	session.feed(tail);
	expect(channel.fed).toEqual([first, tail]);
	await session.finish();
	session.feed(Buffer.alloc(2));
	expect(channel.fed).toEqual([first, tail]);
});

describe("preview session — the end of the recording", () => {
	test("the session owns the panel: mounted on the first event, unmounted exactly once", async () => {
		const channel = fakeChannel();
		const host = fakeHost();
		const session = createPreviewSession(channel, host);

		expect(host.mounts).toBe(0);
		session.handleEvent(partial(0, 1, "hel"));
		expect(host.mounts).toBe(1);
		session.handleEvent(partial(0, 2, "hello"));
		expect(host.mounts).toBe(1);
		// The panel renders through `getText`, so a repaint sees the tail as it is now, not a snapshot.
		expect(host.getText?.()).toBe("hello");

		await session.finish();
		expect(host.unmounts).toBe(1);

		// `finish()` is idempotent and `abort()` after the terminal is a no-op: the entrypoint may call
		// either from its own `finally`, and the panel must not be unmounted a second time.
		await session.finish();
		session.abort();
		expect(host.unmounts).toBe(1);
		expect(host.mounts).toBe(1);
		expect(channel.flushes).toEqual(["stop"]);
		expect(channel.released).toBe(1);
		expect(channel.destroyed).toBe(0);
	});

	test("finish closes synchronously before draining and drops late events", async () => {
		const channel = fakeChannel();
		const host = fakeHost();
		const session = createPreviewSession(channel, host);

		session.handleEvent(partial(0, 1, "你好"));
		// The drain's events arrive while `finish()` is awaiting the stop flush: the segment's commit
		// freezes the tail, and a worker that dies mid-drain is still reportable (§4.3: `degraded` is
		// emittable until the terminal outcome, not until stop).
		channel.onFlush = () => {
			session.handleEvent(commit(0, "你好"));
			session.handleEvent(degraded("preview-worker-failed", "worker exited with code 1"));
		};

		const finishing = session.finish();
		expect(host.unmounts).toBe(1);
		await finishing;

		expect(channel.flushes).toEqual(["stop"]);
		// The commit replaced the tail rather than appending to it: one segment, one copy of its text.
		expect(session.text).toBe("你好");
		expect(session.degraded).toBeNull();
		expect(host.degradations).toHaveLength(0);
		expect(host.unmounts).toBe(1);
		expect(channel.released).toBe(1);
	});

	test("a rejected flush still retires the session instead of failing it", async () => {
		const channel = fakeChannel();
		const host = fakeHost();
		const session = createPreviewSession(channel, host);
		session.handleEvent(partial(0, 1, "你好"));
		channel.flushError = new Error("flush exploded");

		// `finish()` must never reject: the recording's final path may not inherit a preview failure.
		await expect(session.finish()).resolves.toBeUndefined();
		expect(host.unmounts).toBe(1);
		expect(session.text).toBe("你好");
		expect(channel.released).toBe(1);
		// The channel converts its own failures into `degraded`; the session must not invent one.
		expect(session.degraded).toBeNull();
		expect(host.degradations).toHaveLength(0);
	});

	test("a degraded flush's commit may be empty and segment 0, and must not disturb the text", () => {
		const channel = fakeChannel();
		const session = createPreviewSession(channel, fakeHost());

		// The failed-flush commit can carry empty text, and its segment id can be 0 even on a warm
		// worker: it closes a segment, it does not add one.
		expect(() => session.handleEvent(commit(0, ""))).not.toThrow();
		expect(session.text).toBe("");

		// Revisions are global across segments, so the next segment's first partial can be revision 2.
		session.handleEvent(partial(1, 2, "next"));
		// The empty committed segment joins to nothing: no leading separator before the live tail.
		expect(session.text).toBe("next");
	});

	test("an empty commit does not mount the panel", () => {
		const channel = fakeChannel();
		const host = fakeHost();
		const session = createPreviewSession(channel, host);

		// A degraded flush can commit nothing at all. A recording that never showed a word must not
		// reserve the host's spacer line for an empty panel, so the mount waits for composer text.
		session.handleEvent(commit(0, ""));
		expect(session.text).toBe("");
		expect(host.mounts).toBe(0);

		// An empty partial is no better: the first event with words is what mounts it.
		session.handleEvent(partial(1, 1, ""));
		expect(host.mounts).toBe(0);
		session.handleEvent(partial(1, 2, "好"));
		expect(host.mounts).toBe(1);
	});

	test("abort during the stop drain unmounts at once and leaves the release to the drain", async () => {
		const channel = fakeChannel();
		const host = fakeHost();
		const session = createPreviewSession(channel, host);
		session.handleEvent(partial(0, 1, "你好"));

		let settle!: () => void;
		channel.flushGate = new Promise<void>((resolve) => {
			settle = resolve;
		});
		const finished = session.drain();
		expect(channel.flushes).toEqual(["stop"]);

		// A slow or hung worker is exactly the window in which a user reaches for cancel: the panel
		// must go away now, not when the bounded flush finally settles.
		session.abort();
		expect(host.unmounts).toBe(1);
		// The drain still owns the claim; releasing a claim that is still flushing would hand it to the
		// next recording mid-drain.
		expect(channel.released).toBe(0);
		expect(channel.destroyed).toBe(0);

		// Events of a cancelled recording write nothing (§5.1: abort → dispose, no editor write).
		session.handleEvent(commit(0, "你好"));
		expect(session.text).toBe("你好");

		settle();
		await finished;
		// Exactly one release, from the drain that owned it, and exactly one unmount.
		expect(channel.released).toBe(1);
		expect(channel.destroyed).toBe(0);
		expect(host.unmounts).toBe(1);

		// No second terminal: a later `finish()`/`abort()` changes nothing.
		await session.finish();
		session.abort();
		expect(channel.flushes).toEqual(["stop"]);
		expect(channel.released).toBe(1);
		expect(host.unmounts).toBe(1);
	});
});
