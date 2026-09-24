import { describe, expect, test, mock, afterEach } from "bun:test";

// Mock the native sherpa module so recognizer construction is observable.
// Isolated via bun:test per-file worker processes. Empirical guard:
// tests/sherpa-engine.test.ts asserts a REAL version string (/^\d+\.\d+\.\d+$/)
// and runs in the same complete `bun run check` batch, so if this file's
// mock leaked into that file's process, that suite would fail. It does not.
const capturedConfigs: any[] = [];
mock.module("sherpa-onnx-node", () => ({
	version: "0.0.0-mock",
	OfflineTts: { createAsync: async () => {} },
	OfflineRecognizer: class {
		constructor(config: any) {
			capturedConfigs.push(config);
		}
	},
	Vad: class {},
}));

const { initSherpa, getOrCreateRecognizer, clearRecognizerCache } = await import("../extensions/voice/sherpa-engine");
const { LOCAL_MODELS } = await import("../extensions/voice/local");

afterEach(() => (capturedConfigs.length = 0));

describe("recognizer dispatch (mock sherpa-onnx-node)", () => {
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
		// 配置路径断言：sherpa 要求 tokenizer 指向一个包含
		// merges.txt/vocab.json/tokenizer_config.json 的目录；model-download
		// 把这些文件铺平到 modelDir 根，因此此处应传 modelDir 本身。
		// （本测试只断言构造配置，实际下载落盘由下载管线冒烟覆盖。）
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
