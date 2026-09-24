import { describe, expect, test } from "bun:test";
import {
	initSherpa,
	isSherpaAvailable,
	getSherpaError,
	clearRecognizerCache,
	transcribeBuffer,
	transcribeBufferSegmented,
	segmentPcmForLongAudio,
} from "../extensions/voice/sherpa-engine";

// ─── Module loading ──────────────────────────────────────────────────────────

describe("sherpa-onnx-node Bun compatibility", () => {
	test("sherpa-onnx-node module loads via require()", () => {
		const sherpa = require("sherpa-onnx-node");
		expect(sherpa).toBeDefined();
		expect(typeof sherpa.version).toBe("string");
		expect(sherpa.version).toMatch(/^\d+\.\d+\.\d+$/);
	});

	test("sherpa-onnx-node exports OfflineRecognizer constructor", () => {
		const sherpa = require("sherpa-onnx-node");
		expect(typeof sherpa.OfflineRecognizer).toBe("function");
	});

	test("sherpa-onnx-node exports OnlineRecognizer constructor", () => {
		const sherpa = require("sherpa-onnx-node");
		expect(typeof sherpa.OnlineRecognizer).toBe("function");
	});

	test("sherpa-onnx-node loads via ESM dynamic import()", async () => {
		const sherpa = await import("sherpa-onnx-node");
		expect(sherpa).toBeDefined();
		expect(typeof sherpa.OfflineRecognizer).toBe("function");
	});
});

// ─── initSherpa ──────────────────────────────────────────────────────────────

describe("initSherpa", () => {
	test("initializes successfully", async () => {
		const result = await initSherpa();
		expect(result).toBe(true);
	});

	test("isSherpaAvailable returns true after init", async () => {
		await initSherpa();
		expect(isSherpaAvailable()).toBe(true);
	});

	test("getSherpaError returns null on success", async () => {
		await initSherpa();
		expect(getSherpaError()).toBeNull();
	});

	test("initSherpa is idempotent", async () => {
		const first = await initSherpa();
		const second = await initSherpa();
		expect(first).toBe(true);
		expect(second).toBe(true);
	});
});

// ─── Recognizer creation (no model files — error handling) ───────────────────

describe("recognizer error handling", () => {
	test("OfflineRecognizer rejects invalid config gracefully", async () => {
		await initSherpa();
		const sherpa = require("sherpa-onnx-node");

		expect(() => {
			new sherpa.OfflineRecognizer({
				featConfig: { sampleRate: 16000, featureDim: 80 },
				modelConfig: {
					whisper: {
						encoder: "/tmp/nonexistent-encoder.onnx",
						decoder: "/tmp/nonexistent-decoder.onnx",
					},
					tokens: "/tmp/nonexistent-tokens.txt",
					debug: 0,
				},
			});
		}).toThrow();
	});
});

// ─── Cache management ────────────────────────────────────────────────────────

describe("clearRecognizerCache", () => {
	test("clears without error when no recognizer cached", () => {
		expect(() => clearRecognizerCache()).not.toThrow();
	});
});

describe("transcribeBuffer", () => {
	test("accepts PCM buffers with an odd byteOffset", async () => {
		await initSherpa();

		const accepted: { sampleRate: number; samples: Float32Array }[] = [];
		const recognizer = {
			createStream() {
				return {
					acceptWaveform(payload: { sampleRate: number; samples: Float32Array }) {
						accepted.push(payload);
					},
				};
			},
			async decodeAsync() {},
			getResult() {
				return { text: "ok" };
			},
		};

		const pcm = Buffer.from([0, 0, 255, 127, 0, 128, 0, 0]).subarray(1, 7);

		await expect(transcribeBuffer(pcm, recognizer)).resolves.toBe("ok");
		expect(accepted).toHaveLength(1);
		expect(accepted[0]?.sampleRate).toBe(16000);
		expect(Array.from(accepted[0]?.samples || [])).toEqual([-256 / 32768, 127 / 32768, 128 / 32768]);
	});
});

// ─── long-audio VAD segmentation (qwen3-asr / paraformer patch) ────────────

describe("transcribeBufferSegmented", () => {
	// Environment-agnostic: whether or not a Silero VAD model is installed,
	// the result must equal the join of every per-decode result.
	function makeMockRecognizer() {
		const decoded: string[] = [];
		const recognizer = {
			createStream() {
				return { acceptWaveform() {} };
			},
			async decodeAsync() {},
			getResult() {
				const text = `t${decoded.length + 1}`;
				decoded.push(text);
				return { text };
			},
		};
		return { recognizer, decoded };
	}

	test("short audio (≤ threshold) takes the single-decode fast path", async () => {
		const { recognizer, decoded } = makeMockRecognizer();
		const pcm = Buffer.alloc(16000 * 2 * 5); // 5s @16kHz 16-bit
		const result = await transcribeBufferSegmented(pcm, recognizer);
		expect(result).toBe("t1");
		expect(decoded).toEqual(["t1"]);
	});

	test("long audio result equals join of per-segment results", async () => {
		const { recognizer, decoded } = makeMockRecognizer();
		const pcm = Buffer.alloc(16000 * 2 * 30); // 30s @16kHz 16-bit
		const result = await transcribeBufferSegmented(pcm, recognizer, 10);
		expect(result).toBe(decoded.join(" "));
		expect(decoded.length).toBeGreaterThan(0);
	});
});

describe("segmentPcmForLongAudio", () => {
	test("silence-only long input yields exactly one buffer", () => {
		// With VAD installed: silence produces zero speech segments → fallback.
		// Without VAD: graceful degradation returns the whole buffer.
		const samples = new Float32Array(16000 * 30); // 30s of silence
		const out = segmentPcmForLongAudio(samples, 16000, 10);
		expect(out).toHaveLength(1);
	});
});
