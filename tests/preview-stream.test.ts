import { describe, expect, test } from "bun:test";
import {
	createPreviewStream,
	type OnlineRecognizerLike,
	type PreviewStreamEvent,
	type PreviewStreamLike,
	type PreviewStreamOptions,
} from "../extensions/voice/preview-stream";

/**
 * The preview's segmenting rules, pinned as recogniser call order rather than through side effects.
 *
 * Spec: docs/superpowers/specs/2026-10-22-local-streaming-preview-design.md §5.3. The properties a
 * user can tell apart: a boundary drains the tail before it commits (otherwise the last words of
 * every segment vanish while every test still passes), the 60 s cap ends a segment and not the
 * recording, and pause/cap/stop never end the same segment twice.
 */

const SAMPLE_RATE = 16_000;
const CHUNK_SAMPLES = 1_600; // 100 ms of capture
const TAIL_SAMPLES = 6_400; // the 400 ms drain

function testOptions(overrides: Partial<PreviewStreamOptions> = {}): PreviewStreamOptions {
	return {
		sampleRate: SAMPLE_RATE,
		segmentCapMs: 60_000,
		tailSilenceMs: 400,
		now: () => 0,
		onEvent: () => {},
		...overrides,
	};
}

/** A PCM16LE chunk whose samples all carry `value`, so the stream a chunk reached is identifiable. */
function pcm16(value: number, count = CHUNK_SAMPLES): Buffer {
	const buffer = Buffer.alloc(count * 2);
	for (let i = 0; i < count; i++) buffer.writeInt16LE(value, i * 2);
	return buffer;
}

const silence = (count = CHUNK_SAMPLES) => pcm16(0, count);

function createRecorder(): { events: PreviewStreamEvent[]; onEvent: (event: PreviewStreamEvent) => void } {
	const events: PreviewStreamEvent[] = [];
	return { events, onEvent: (event) => events.push(event) };
}

/** One recorded recogniser call. */
type Call =
	| { op: "createStream"; stream: number }
	| { op: "acceptWaveform"; stream: number; sampleRate: number; samples: Float32Array }
	| { op: "inputFinished"; stream: number }
	| { op: "isReady"; stream: number; ready: boolean }
	| { op: "decode"; stream: number }
	| { op: "isEndpoint"; stream: number; endpoint: boolean }
	| { op: "getResult"; stream: number; text: string };

interface FakeStream extends PreviewStreamLike {
	id: number;
	accepts: { sampleRate: number; samples: Float32Array }[];
	/** Decodes the stream still owes: one per accepted chunk, two more once `inputFinished()` landed. */
	pending: number;
	decodes: number;
	text: string;
}

interface FakeOptions {
	/** The text the stream holds after its `decodes`-th decode. */
	textFor?: (streamId: number, decodes: number) => string;
	/** Scripted `isEndpoint()` answers, one per call; anything past the script is `false`. */
	endpoints?: boolean[];
}

/**
 * A recogniser that records every call. `isReady()` is true only while a stream still owes a decode,
 * which is what makes "decode until not ready" observable: a drain that forgets `inputFinished()` (or
 * the silence) leaves decodes owed and the assertion on the recorded order fails.
 */
function createFake(options: FakeOptions = {}) {
	const calls: Call[] = [];
	const streams: FakeStream[] = [];
	const endpoints = [...(options.endpoints ?? [])];
	const textFor = options.textFor ?? ((streamId: number, decodes: number) => `${streamId}#${decodes}`);

	const recognizer: OnlineRecognizerLike = {
		createStream(): PreviewStreamLike {
			const id = streams.length;
			const stream: FakeStream = {
				id,
				accepts: [],
				pending: 0,
				decodes: 0,
				text: "",
				acceptWaveform(input) {
					stream.accepts.push(input);
					stream.pending += 1;
					calls.push({ op: "acceptWaveform", stream: id, sampleRate: input.sampleRate, samples: input.samples });
				},
				inputFinished() {
					stream.pending += 2;
					calls.push({ op: "inputFinished", stream: id });
				},
			};
			streams.push(stream);
			calls.push({ op: "createStream", stream: id });
			return stream;
		},
		isReady(stream) {
			const fake = stream as FakeStream;
			const ready = fake.pending > 0;
			calls.push({ op: "isReady", stream: fake.id, ready });
			return ready;
		},
		decode(stream) {
			const fake = stream as FakeStream;
			fake.pending -= 1;
			fake.decodes += 1;
			fake.text = textFor(fake.id, fake.decodes);
			calls.push({ op: "decode", stream: fake.id });
		},
		isEndpoint(stream) {
			const endpoint = endpoints.shift() ?? false;
			calls.push({ op: "isEndpoint", stream: (stream as FakeStream).id, endpoint });
			return endpoint;
		},
		getResult(stream) {
			const fake = stream as FakeStream;
			calls.push({ op: "getResult", stream: fake.id, text: fake.text });
			return { text: fake.text };
		},
	};

	return { recognizer, streams, calls, ops: () => calls.map((call) => call.op) };
}

describe("createPreviewStream — the tail drain", () => {
	test("a flush drains the tail: silence, inputFinished, decode until not ready, then one commit", () => {
		const fake = createFake({ textFor: (_id, decodes) => (decodes >= 3 ? "hello world" : "hello") });
		const { events, onEvent } = createRecorder();
		const stream = createPreviewStream(fake.recognizer, testOptions({ onEvent }));

		stream.feed(silence());
		stream.flush("pause");

		expect(fake.ops()).toEqual([
			// the fed chunk decodes once and produces the live tail
			"createStream",
			"acceptWaveform",
			"isReady",
			"decode",
			"isReady",
			"getResult",
			"isEndpoint",
			// the boundary drains: 400 ms of silence, then the finished stream is decoded to exhaustion
			"acceptWaveform",
			"inputFinished",
			"isReady",
			"decode",
			"isReady",
			"decode",
			"isReady",
			"decode",
			"isReady",
			"getResult",
		]);
		const tail = fake.streams[0]?.accepts[1];
		expect(tail?.sampleRate).toBe(SAMPLE_RATE);
		expect(tail?.samples.length).toBe(TAIL_SAMPLES);
		expect(tail?.samples.every((sample) => sample === 0)).toBe(true);
		expect(events).toEqual([
			{ kind: "partial", segmentId: 0, revision: 1, text: "hello" },
			{ kind: "commit", segmentId: 0, text: "hello world" },
		]);
	});

	test("a flush with no audio commits nothing and leaves the segment open", () => {
		const fake = createFake();
		const { events, onEvent } = createRecorder();
		const stream = createPreviewStream(fake.recognizer, testOptions({ onEvent }));

		stream.flush("stop");
		expect(fake.ops()).toEqual([]);
		expect(events).toEqual([]);

		// The first real audio still belongs to segment 0: a flush is not a segment id bump.
		stream.feed(silence());
		stream.flush("stop");
		expect(events.filter((event) => event.kind === "commit")).toEqual([{ kind: "commit", segmentId: 0, text: "0#4" }]);
	});

	test("a repeated flush does not end the same segment twice", () => {
		const fake = createFake();
		const { events, onEvent } = createRecorder();
		const stream = createPreviewStream(fake.recognizer, testOptions({ onEvent }));

		stream.feed(silence());
		stream.flush("pause");
		const callsAfterFirstFlush = fake.calls.length;
		stream.flush("stop");

		expect(fake.calls.length).toBe(callsAfterFirstFlush);
		expect(events.filter((event) => event.kind === "commit")).toHaveLength(1);
	});

	test("every flush reason ends exactly one segment", () => {
		for (const reason of ["pause", "cap", "stop"] as const) {
			const fake = createFake();
			const { events, onEvent } = createRecorder();
			const stream = createPreviewStream(fake.recognizer, testOptions({ onEvent }));
			stream.feed(silence());
			stream.flush(reason);
			expect(events.filter((event) => event.kind === "commit")).toEqual([
				{ kind: "commit", segmentId: 0, text: "0#4" },
			]);
		}
	});

	test("a segment that decoded nothing still commits exactly once", () => {
		const fake = createFake({ textFor: () => "" });
		const { events, onEvent } = createRecorder();
		const stream = createPreviewStream(fake.recognizer, testOptions({ onEvent }));

		stream.feed(silence());
		expect(events).toEqual([]); // an empty text is not a partial
		stream.flush("stop");
		expect(events).toEqual([{ kind: "commit", segmentId: 0, text: "" }]);
	});
});

describe("createPreviewStream — the 60 s cap", () => {
	test("the 60 s cap ends a segment, not the stream", () => {
		let now = 0;
		const fake = createFake();
		const { events, onEvent } = createRecorder();
		const stream = createPreviewStream(fake.recognizer, testOptions({ now: () => now, onEvent }));

		stream.feed(pcm16(1000));
		now = 60_000;
		stream.feed(pcm16(2000)); // this chunk crosses the cap, so it belongs to the successor

		expect(events).toEqual([
			{ kind: "partial", segmentId: 0, revision: 1, text: "0#1" },
			{ kind: "commit", segmentId: 0, text: "0#4" },
			{ kind: "partial", segmentId: 1, revision: 2, text: "1#1" },
		]);
		expect(fake.streams).toHaveLength(2);
		// Segment 0 got its own chunk and the drain; the crossing chunk never replayed into it.
		expect(fake.streams[0]?.accepts).toHaveLength(2);
		expect(fake.streams[0]?.accepts[1]?.samples.length).toBe(TAIL_SAMPLES);
		// Segment 1 received the crossing chunk exactly once.
		expect(fake.streams[1]?.accepts).toHaveLength(1);
		expect(fake.streams[1]?.accepts[0]?.samples[0]).toBeCloseTo(2000 / 32768, 6);
	});

	test("the cap clock restarts at every segment", () => {
		let now = 0;
		const fake = createFake();
		const { events, onEvent } = createRecorder();
		const stream = createPreviewStream(fake.recognizer, testOptions({ now: () => now, onEvent }));

		stream.feed(pcm16(1000));
		now = 60_000;
		stream.feed(pcm16(2000)); // cap: segment 1 opens here, so its clock starts at 60 s
		now = 119_999;
		stream.feed(pcm16(3000)); // 59.999 s into segment 1: still inside the cap
		expect(events.filter((event) => event.kind === "commit")).toHaveLength(1);

		now = 120_000;
		stream.feed(pcm16(4000)); // 60 s into segment 1: the cap fires again
		const commits = events.filter((event) => event.kind === "commit");
		expect(commits).toHaveLength(2);
		expect(commits.map((event) => (event.kind === "commit" ? event.segmentId : -1))).toEqual([0, 1]);
		expect(fake.streams).toHaveLength(3);
		expect(fake.streams[2]?.accepts).toHaveLength(1);
		expect(fake.streams[2]?.accepts[0]?.samples[0]).toBeCloseTo(4000 / 32768, 6);
	});

	test("successor audio is drained once after a stop flush", () => {
		let now = 0;
		const fake = createFake();
		const { events, onEvent } = createRecorder();
		const stream = createPreviewStream(fake.recognizer, testOptions({ now: () => now, onEvent }));

		stream.feed(pcm16(1000));
		now = 60_000;
		stream.feed(pcm16(2000)); // cap flush commits segment 0 and opens segment 1 with audio
		stream.flush("stop"); // must commit segment 1 once and not chase an empty successor

		const commits = events.filter((event) => event.kind === "commit");
		expect(commits).toEqual([
			{ kind: "commit", segmentId: 0, text: "0#4" },
			{ kind: "commit", segmentId: 1, text: "1#4" },
		]);
		expect(fake.streams).toHaveLength(2);

		stream.flush("stop"); // idempotent: nothing is left to drain
		expect(events.filter((event) => event.kind === "commit")).toHaveLength(2);
	});
});

describe("createPreviewStream — endpoints", () => {
	test("an endpoint ends a segment exactly once and audio after it reaches the next stream", () => {
		const fake = createFake({ endpoints: [false, false, true] });
		const { events, onEvent } = createRecorder();
		const stream = createPreviewStream(fake.recognizer, testOptions({ onEvent }));

		stream.feed(pcm16(1000));
		stream.feed(pcm16(2000));
		stream.feed(pcm16(3000)); // the fake reports the endpoint after this chunk

		expect(events.filter((event) => event.kind === "commit")).toEqual([{ kind: "commit", segmentId: 0, text: "0#6" }]);

		// The endpoint already ended the segment; a pause flush for the same boundary must not repeat it.
		stream.flush("pause");
		expect(events.filter((event) => event.kind === "commit")).toHaveLength(1);

		// The successor opens for the next chunk, not before it: a boundary ends a segment, it does not
		// manufacture an empty one.
		expect(fake.streams).toHaveLength(1);
		stream.feed(pcm16(4000));
		expect(fake.streams).toHaveLength(2);
		const retired = fake.streams[0];
		const successor = fake.streams[1];
		expect(retired?.accepts).toHaveLength(4); // three chunks and the drain, nothing after the boundary
		expect(retired?.accepts[3]?.samples.length).toBe(TAIL_SAMPLES);
		expect(successor?.accepts).toHaveLength(1);
		expect(successor?.accepts[0]?.samples[0]).toBeCloseTo(4000 / 32768, 6);
	});

	test("a stop after an endpoint commits only the successor", () => {
		const fake = createFake({ endpoints: [true] });
		const { events, onEvent } = createRecorder();
		const stream = createPreviewStream(fake.recognizer, testOptions({ onEvent }));

		stream.feed(pcm16(1000)); // endpoint right away: segment 0 is committed inside feed
		stream.feed(pcm16(2000)); // segment 1
		stream.flush("stop");

		expect(events.filter((event) => event.kind === "commit")).toEqual([
			{ kind: "commit", segmentId: 0, text: "0#4" },
			{ kind: "commit", segmentId: 1, text: "1#4" },
		]);
	});
});

describe("createPreviewStream — partials", () => {
	test("a partial is emitted only when the text changes, with a strictly increasing revision", () => {
		const fake = createFake({ textFor: (_id, decodes) => ["he", "hel", "hel", "hello"][decodes - 1] ?? "hello" });
		const { events, onEvent } = createRecorder();
		const stream = createPreviewStream(fake.recognizer, testOptions({ onEvent }));

		stream.feed(silence());
		stream.feed(silence());
		stream.feed(silence()); // the text did not move: no partial
		stream.feed(silence());

		expect(events).toEqual([
			{ kind: "partial", segmentId: 0, revision: 1, text: "he" },
			{ kind: "partial", segmentId: 0, revision: 2, text: "hel" },
			{ kind: "partial", segmentId: 0, revision: 3, text: "hello" },
		]);
	});

	test("the event text is trimmed at the edges", () => {
		const fake = createFake({ textFor: () => "  你好 " });
		const { events, onEvent } = createRecorder();
		const stream = createPreviewStream(fake.recognizer, testOptions({ onEvent }));

		stream.feed(silence());
		stream.flush("stop");

		expect(events).toEqual([
			{ kind: "partial", segmentId: 0, revision: 1, text: "你好" },
			{ kind: "commit", segmentId: 0, text: "你好" },
		]);
	});
});

describe("createPreviewStream — input", () => {
	test("a chunk is 16-bit signed little-endian PCM at the configured rate", () => {
		const fake = createFake();
		const { onEvent } = createRecorder();
		const stream = createPreviewStream(fake.recognizer, testOptions({ sampleRate: 8_000, onEvent }));
		const buffer = Buffer.alloc(6);
		buffer.writeInt16LE(0, 0);
		buffer.writeInt16LE(8192, 2);
		buffer.writeInt16LE(-32768, 4);

		stream.feed(buffer);

		expect(fake.streams[0]?.accepts[0]?.sampleRate).toBe(8_000);
		expect([...(fake.streams[0]?.accepts[0]?.samples ?? [])]).toEqual([0, 0.25, -1]);
	});

	test("a pooled chunk that starts at an odd byte offset still converts", () => {
		const fake = createFake();
		const { onEvent } = createRecorder();
		const stream = createPreviewStream(fake.recognizer, testOptions({ onEvent }));
		const pool = Buffer.alloc(4);
		pool.writeInt16LE(8192, 1); // samples at byte 1: an unaligned offset, as pooled Buffers can have

		stream.feed(pool.subarray(1, 3));

		expect([...(fake.streams[0]?.accepts[0]?.samples ?? [])]).toEqual([0.25]);
	});

	test("an empty or half-sample chunk is not audio", () => {
		const fake = createFake();
		const { events, onEvent } = createRecorder();
		const stream = createPreviewStream(fake.recognizer, testOptions({ onEvent }));

		stream.feed(Buffer.alloc(0));
		stream.feed(Buffer.alloc(1));
		stream.flush("stop");

		expect(fake.ops()).toEqual([]);
		expect(events).toEqual([]);
	});
});
