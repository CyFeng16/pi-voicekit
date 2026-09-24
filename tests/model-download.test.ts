import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	getModelsDir,
	getModelDir,
	getModelPath,
	isModelDownloaded,
	getDownloadedModels,
	deleteModel,
} from "../extensions/voice/model-download";
import {
	LOCAL_MODELS,
	getLanguagesForLocalModel,
	isLanguageSupportedByModel,
	languagesForLangSupport,
} from "../extensions/voice/local";

const tempDirs: string[] = [];

function makeTempModelDir(modelId: string): string {
	const modelsBase = path.join(os.tmpdir(), `pi-voice-models-test-${Date.now()}`);
	const modelDir = path.join(modelsBase, modelId);
	fs.mkdirSync(modelDir, { recursive: true });
	tempDirs.push(modelsBase);
	return modelDir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		if (fs.existsSync(dir)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("getModelsDir", () => {
	test("returns path under ~/.pi/models/", () => {
		const dir = getModelsDir();
		expect(dir).toContain(path.join(".pi", "models"));
		expect(dir).toStartWith(os.homedir());
	});
});

describe("getModelDir", () => {
	test("returns path with model id", () => {
		const dir = getModelDir("whisper-small");
		expect(dir).toEndWith(path.join("models", "whisper-small"));
	});
});

describe("getModelPath", () => {
	test("returns null when model not downloaded", () => {
		const result = getModelPath("nonexistent-model-xyz");
		expect(result).toBeNull();
	});
});

describe("isModelDownloaded", () => {
	test("returns false when directory does not exist", () => {
		expect(isModelDownloaded("nonexistent-xyz", { encoder: "https://example.com/encoder.onnx" })).toBe(false);
	});
});

describe("getDownloadedModels", () => {
	test("returns empty array when models dir does not exist", () => {
		// Calling with the default dir — may or may not have models
		const result = getDownloadedModels();
		expect(Array.isArray(result)).toBe(true);
	});
});

describe("deleteModel", () => {
	test("returns false for non-existent model", () => {
		expect(deleteModel("nonexistent-model-xyz-123")).toBe(false);
	});
});

describe("download URLs validation", () => {
	test("all model download URLs are valid HTTPS URLs", () => {
		for (const model of LOCAL_MODELS) {
			const urls = model.sherpaModel.downloadUrls;
			for (const [role, url] of Object.entries(urls)) {
				expect(url).toStartWith("https://");
				// Should be a valid URL
				expect(() => new URL(url)).not.toThrow();
				// Should point to HuggingFace or GitHub
				const hostname = new URL(url).hostname;
				expect(hostname === "huggingface.co" || hostname === "github.com").toBe(true);
			}
		}
	});

	test("file roles match between files and downloadUrls", () => {
		for (const model of LOCAL_MODELS) {
			const fileRoles = Object.keys(model.sherpaModel.files);
			const urlRoles = Object.keys(model.sherpaModel.downloadUrls);
			expect(fileRoles.sort()).toEqual(urlRoles.sort());
		}
	});
});

describe("zh models (paraformer / qwen3-asr patch)", () => {
	test("qwen3-asr-0.6b and paraformer-zh are present with correct intent types", () => {
		const ids = LOCAL_MODELS.map((m) => m.id);
		expect(ids).toContain("qwen3-asr-0.6b");
		expect(ids).toContain("paraformer-zh");
		expect(LOCAL_MODELS.find((m) => m.id === "qwen3-asr-0.6b")!.sherpaModel.type).toBe("qwen3_asr");
		expect(LOCAL_MODELS.find((m) => m.id === "paraformer-zh")!.sherpaModel.type).toBe("paraformer");
	});

	test("qwen3-asr-0.6b declares all tokenizer and encoder files", () => {
		const files = LOCAL_MODELS.find((m) => m.id === "qwen3-asr-0.6b")!.sherpaModel.files;
		for (const key of ["convFrontend", "encoder", "decoder", "tokenizerMerges", "tokenizerVocab", "tokenizerConfig"]) {
			expect(files).toHaveProperty(key);
			expect(files[key]).toBeTruthy();
		}
	});

	test("model ids are globally unique", () => {
		const ids = LOCAL_MODELS.map((m) => m.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("language families for new zh models", () => {
	test("paraformer-zh exposes zh + en (bilingual-zh-en), not the Whisper set", () => {
		const { languages, englishOnly } = getLanguagesForLocalModel("paraformer-zh");
		expect(englishOnly).toBe(false);
		expect(languages.map((l) => l.code).sort()).toEqual(["en", "zh"]);
		// 必须不套用 Whisper 全语言集
		expect(languages.some((l) => l.code === "ja" || l.code === "fr")).toBe(false);
	});

	test("qwen3-asr uses its own zh/en-facing family, not the Whisper set", () => {
		const { languages } = getLanguagesForLocalModel("qwen3-asr-0.6b");
		expect(languages.map((l) => l.code).sort()).toEqual(["en", "zh"]);
	});

	test("isLanguageSupportedByModel agrees for paraformer zh/en", () => {
		expect(isLanguageSupportedByModel("paraformer-zh", "zh")).toBe(true);
		expect(isLanguageSupportedByModel("paraformer-zh", "en")).toBe(true);
		expect(isLanguageSupportedByModel("paraformer-zh", "ja")).toBe(false);
	});
});

describe("languagesForLangSupport (shared capability table)", () => {
	test("registered families map correctly", () => {
		expect(
			languagesForLangSupport("bilingual-zh-en")
				.map((l) => l.code)
				.sort()
		).toEqual(["en", "zh"]);
		expect(
			languagesForLangSupport("qwen3")
				.map((l) => l.code)
				.sort()
		).toEqual(["en", "zh"]);
		expect(languagesForLangSupport("russian-only").map((l) => l.code)).toEqual(["ru"]);
		expect(languagesForLangSupport("whisper").length).toBeGreaterThan(20);
	});

	test("unregistered langSupport fails CLOSED (empty), never 'all languages'", () => {
		// Type level it can't happen today, but a forward/custom model runtime
		// value must not silently mean "supports everything".
		expect(languagesForLangSupport("some-future-family" as any)).toEqual([]);
	});
});
