import { describe, expect, test } from "bun:test";
import {
	TTS_LOCAL_MODELS,
	DEFAULT_TTS_MODEL,
	getTtsModel,
	getDefaultVoiceSid,
	languageName,
	modelSupportsLanguage,
} from "../extensions/voice/tts-local-models";

describe("TTS_LOCAL_MODELS catalog shape", () => {
	test("default model exists", () => {
		expect(TTS_LOCAL_MODELS.find((m) => m.id === DEFAULT_TTS_MODEL)).toBeDefined();
	});

	test("every entry has at least one voice", () => {
		for (const m of TTS_LOCAL_MODELS) {
			expect(m.voices.length).toBeGreaterThan(0);
		}
	});

	test("every entry's defaultSid maps to a real voice", () => {
		for (const m of TTS_LOCAL_MODELS) {
			expect(m.voices.some((v) => v.sid === m.defaultSid)).toBe(true);
		}
	});

	test("every archive URL is HTTPS to a verified host", () => {
		for (const m of TTS_LOCAL_MODELS) {
			expect(m.archiveUrl.startsWith("https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/")).toBe(true);
			expect(m.archiveUrl.endsWith(".tar.bz2")).toBe(true);
		}
	});

	test("sherpaSlot ∈ {kitten, vits, kokoro}", () => {
		for (const m of TTS_LOCAL_MODELS) {
			expect(["kitten", "vits", "kokoro"]).toContain(m.sherpaSlot);
		}
	});

	test("sample rate is sane", () => {
		for (const m of TTS_LOCAL_MODELS) {
			expect(m.sampleRate).toBeGreaterThanOrEqual(16000);
			expect(m.sampleRate).toBeLessThanOrEqual(48000);
		}
	});
});

describe("getTtsModel", () => {
	test("returns the entry by id", () => {
		const m = getTtsModel(DEFAULT_TTS_MODEL);
		expect(m.id).toBe(DEFAULT_TTS_MODEL);
	});

	test("throws on unknown id", () => {
		expect(() => getTtsModel("not-a-real-model")).toThrow(/Unknown TTS model/);
	});
});

describe("getDefaultVoiceSid", () => {
	test("returns model.defaultSid when valid", () => {
		const m = getTtsModel(DEFAULT_TTS_MODEL);
		expect(getDefaultVoiceSid(m)).toBe(m.defaultSid);
	});
});

describe("languageName", () => {
	test("known bases map to English names", () => {
		expect(languageName("en")).toBe("English");
		expect(languageName("es-ES")).toBe("Spanish");
		expect(languageName("zh")).toBe("Chinese");
	});

	test("unknown bases fall back to the raw tag", () => {
		expect(languageName("xx")).toBe("xx");
	});

	test("empty input returns empty", () => {
		expect(languageName("")).toBe("");
	});
});

describe("modelSupportsLanguage — region-strict matching", () => {
	const piperBR = getTtsModel("piper-pt_BR-cadu-medium-int8");

	test("exact regional match wins", () => {
		expect(modelSupportsLanguage(piperBR, "pt-BR")).toBe(true);
	});

	test("pt-PT does NOT match pt-BR (the regression we hardened against)", () => {
		expect(modelSupportsLanguage(piperBR, "pt-PT")).toBe(false);
	});

	test("bare 'pt' matches the only Portuguese entry in the catalog", () => {
		// Only one Portuguese region in the catalog → bare "pt" should
		// resolve to it deterministically.
		expect(modelSupportsLanguage(piperBR, "pt")).toBe(true);
	});

	test("Kokoro multilingual covers all listed languages by base tag", () => {
		const kokoro = getTtsModel("kokoro-int8-multi-lang-v1_0");
		expect(modelSupportsLanguage(kokoro, "en")).toBe(true);
		expect(modelSupportsLanguage(kokoro, "zh")).toBe(true);
		expect(modelSupportsLanguage(kokoro, "ja")).toBe(true);
	});

	test("region case is normalized for matching", () => {
		expect(modelSupportsLanguage(piperBR, "PT-br")).toBe(true);
	});
});
