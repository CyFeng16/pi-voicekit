import { describe, expect, test, mock, afterEach } from "bun:test";

// Runs in its OWN bun test subprocess (spawned by tests/sherpa-dispatch.test.ts),
// so the mock registry below can never leak into sibling test files of the same
// `bun test` batch: bun.mock.module is process-global, and a leaked mock made
// tests/sherpa-engine.test.ts observe version "0.0.0-mock" on CI.

const capturedConfigs: any[] = [];
const capturedVadConfigs: any[] = [];

/** The segmenter only reads `config` and drains an empty queue; capture what it is handed. */
class MockVad {
	config: any;

	constructor(config: any) {
		capturedVadConfigs.push(config);
		this.config = config;
	}

	acceptWaveform() {}
	isEmpty() {
		return true;
	}
	front() {
		return { samples: new Float32Array(0) };
	}
	pop() {}
	flush() {}
}

mock.module("sherpa-onnx-node", () => ({
	version: "0.0.0-mock",
	OfflineTts: { createAsync: async () => {} },
	OfflineRecognizer: class {
		constructor(config: any) {
			capturedConfigs.push(config);
		}
	},
	Vad: MockVad,
}));

const { initSherpa, getOrCreateRecognizer, clearRecognizerCache, segmentPcmForLongAudio } = await import(
	"../extensions/voice/sherpa-engine"
);
const { LOCAL_MODELS } = await import("../extensions/voice/local");

afterEach(() => (capturedConfigs.length = 0));

describe("recognizer dispatch (mock sherpa-onnx-node, isolated subprocess)", () => {
	test("transducer models dispatch to the transducer branch, NOT paraformer", async () => {
		await initSherpa();
		const parakeet = LOCAL_MODELS.find((m) => m.id === "parakeet-v3")!;
		expect(parakeet.sherpaModel.type).toBe("transducer");

		getOrCreateRecognizer(parakeet, "/tmp/model-x", "en");
		const cfg = capturedConfigs[0]!.modelConfig;
		expect(cfg.transducer).toBeDefined();
		expect(cfg.paraformer).toBeUndefined();
		expect(cfg.qwen3Asr).toBeUndefined();
		clearRecognizerCache();
	});

	test("paraformer-zh dispatches to the paraformer branch", async () => {
		await initSherpa();
		const m = LOCAL_MODELS.find((x) => x.id === "paraformer-zh")!;
		expect(m.sherpaModel.type).toBe("paraformer");

		getOrCreateRecognizer(m, "/tmp/model-p", "zh");
		const cfg = capturedConfigs[0]!.modelConfig;
		expect(cfg.paraformer).toBeDefined();
		expect(cfg.transducer).toBeUndefined();
		expect(cfg.qwen3Asr).toBeUndefined();
		clearRecognizerCache();
	});

	test("qwen3-asr dispatches with tokenizer pointing at modelDir (config path assertion)", async () => {
		await initSherpa();
		const m = LOCAL_MODELS.find((x) => x.id === "qwen3-asr-0.6b")!;
		expect(m.sherpaModel.type).toBe("qwen3_asr");

		const dir = "/tmp/model-q";
		getOrCreateRecognizer(m, dir, "zh");
		const cfg = capturedConfigs[0]!.modelConfig;
		expect(cfg.qwen3Asr).toBeDefined();
		expect(cfg.qwen3Asr.encoder).toBe(`${dir}/encoder.int8.onnx`);
		expect(cfg.qwen3Asr.convFrontend).toBe(`${dir}/conv_frontend.onnx`);
		// Config-path assertion: sherpa requires the tokenizer to point at a
		// directory containing merges.txt/vocab.json/tokenizer_config.json;
		// model-download flattens those files into the modelDir root, so we pass
		// modelDir itself. (This test only asserts construction config; actual
		// download-to-disk is covered by the download-pipeline smoke tests.)
		expect(cfg.qwen3Asr.tokenizer).toBe(dir);
		expect(cfg.paraformer).toBeUndefined();
		expect(cfg.transducer).toBeUndefined();
		clearRecognizerCache();
	});

	test("unknown sherpa model type throws", () => {
		expect(() =>
			getOrCreateRecognizer({ id: "bogus", sherpaModel: { type: "bogus_type" } } as any, "/tmp/x", "en")
		).toThrow(/Unknown sherpa model type/);
		clearRecognizerCache();
	});
});

describe("VAD segmentation config (mock sherpa-onnx-node, isolated subprocess)", () => {
	test("hands the shipped 1 s pause to the VAD", () => {
		// `tests/sherpa-dispatch.test.ts` spawns this probe with HOME pointing at a temp dir that
		// holds a marker `silero_vad.onnx`, so the segmenter takes the VAD path without touching
		// the developer's real ~/.pi/models/vad. The pause is the value a 0.3.2 sweep justified,
		// and this is the only assertion that stops it being changed silently.
		segmentPcmForLongAudio(new Float32Array(16000 * 5), 16000, 10);
		const config = capturedVadConfigs.at(-1);
		expect(config).toBeDefined();
		expect(config.sileroVad.minSilenceDuration).toBe(1);
		expect(config.sileroVad.maxSpeechDuration).toBe(10);
	});
});
