import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { decodeSegmentsInOrder, initSherpa, transcribeBufferSegmented } from "../extensions/voice/sherpa-engine";
import { startLocalSession } from "../extensions/voice/local";

/**
 * Recogniser stub: one decoded text per segment, in decode order, plus an event log that
 * pins decodes against the `onSegment` calls they must precede. Drives the exported
 * in-order decode seam, so no sherpa native call and no VAD model is involved.
 */
function makeStubRecognizer(texts: readonly string[]) {
	let decoded = 0;
	const events: string[] = [];
	const recognizer = {
		createStream() {
			return { acceptWaveform() {} };
		},
		async decodeAsync() {
			events.push(`decode:${decoded}`);
		},
		getResult() {
			const text = texts[decoded] ?? "";
			decoded += 1;
			return { text };
		},
	};
	return { recognizer, events };
}

function segment(): Float32Array {
	return new Float32Array(1600);
}

function fakeRecProcess(): ChildProcess {
	const proc = new EventEmitter() as unknown as ChildProcess;
	const streams = proc as unknown as { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean };
	streams.stdout = new EventEmitter();
	streams.stderr = new EventEmitter();
	streams.kill = () => true;
	return proc;
}

describe("decodeSegmentsInOrder", () => {
	test("reports each segment as it decodes, before the next decode, with contiguous indices", async () => {
		const { recognizer, events } = makeStubRecognizer(["first part", "第二段", "third part"]);
		const seen: Array<[string, number]> = [];
		const parts = await decodeSegmentsInOrder(recognizer, [segment(), segment(), segment()], (text, index) => {
			events.push(`onSegment:${index}`);
			seen.push([text, index]);
		});

		expect(seen).toEqual([
			["first part", 0],
			["第二段", 1],
			["third part", 2],
		]);
		expect(events).toEqual(["decode:0", "onSegment:0", "decode:1", "onSegment:1", "decode:2", "onSegment:2"]);
		// Today's concatenation, byte for byte.
		expect(parts.join(" ")).toBe("first part 第二段 third part");
	});

	test("without a callback the parts are byte-identical to today's concatenation", async () => {
		const { recognizer } = makeStubRecognizer(["a", "b", "c"]);
		await expect(decodeSegmentsInOrder(recognizer, [segment(), segment(), segment()])).resolves.toEqual([
			"a",
			"b",
			"c",
		]);
	});

	test("empty segments are still reported but skipped by the join", async () => {
		const { recognizer } = makeStubRecognizer(["a", "", "c"]);
		const seen: Array<[string, number]> = [];
		const parts = await decodeSegmentsInOrder(recognizer, [segment(), segment(), segment()], (text, index) =>
			seen.push([text, index])
		);

		expect(seen).toEqual([
			["a", 0],
			["", 1],
			["c", 2],
		]);
		expect(parts.join(" ")).toBe("a c");
	});

	test("a throwing observer cannot cost the transcript", async () => {
		const { recognizer } = makeStubRecognizer(["a", "b"]);
		const parts = await decodeSegmentsInOrder(recognizer, [segment(), segment()], () => {
			throw new Error("observer exploded");
		});

		expect(parts.join(" ")).toBe("a b");
	});
});

describe("transcribeBufferSegmented onSegment", () => {
	test("a short dictation reports its single fast-path segment once, with the old return value", async () => {
		await initSherpa();
		const pcm = Buffer.alloc(16000 * 2 * 5); // 5s @16kHz 16-bit

		const withoutCallback = await transcribeBufferSegmented(pcm, makeStubRecognizer(["hello"]).recognizer);
		const seen: Array<[string, number]> = [];
		const withCallback = await transcribeBufferSegmented(
			pcm,
			makeStubRecognizer(["hello"]).recognizer,
			10,
			(text, index) => seen.push([text, index])
		);

		expect(withoutCallback).toBe("hello");
		expect(withCallback).toBe(withoutCallback);
		expect(seen).toEqual([["hello", 0]]);
	});

	test("a long dictation reports every decoded segment in order and keeps today's join", async () => {
		await initSherpa();
		const pcm = Buffer.alloc(16000 * 2 * 30); // 30s @16kHz 16-bit

		const seen: Array<[string, number]> = [];
		const recognizer = makeStubRecognizer(["t1", "t2", "t3", "t4"]).recognizer;
		const result = await transcribeBufferSegmented(pcm, recognizer, 10, (text, index) => seen.push([text, index]));

		// Whether or not a Silero VAD model is installed, every decode is reported.
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.map(([, index]) => index)).toEqual(seen.map((_, index) => index));
		expect(result).toBe(seen.map(([text]) => text).join(" "));
	});
});

describe("LocalSessionCallbacks.onSegment", () => {
	test("startLocalSession carries the optional callback onto the session", () => {
		const onSegment = () => {};
		const session = startLocalSession(fakeRecProcess(), {
			onTranscript() {},
			onDone() {},
			onError() {},
			onSegment,
		});

		expect(session.onSegment).toBe(onSegment);
	});

	test("without a callback the session's onSegment stays undefined", () => {
		const session = startLocalSession(fakeRecProcess(), { onTranscript() {}, onDone() {}, onError() {} });

		expect(session.onSegment).toBeUndefined();
	});
});
