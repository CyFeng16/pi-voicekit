/**
 * Local transcription backend — in-process STT via sherpa-onnx.
 *
 * sherpa-onnx runs in-process (zero-config, auto-download models). Transcription is
 * batch mode: record the complete audio, then transcribe after stop.
 *
 * Model catalog verified against HuggingFace repos:
 *   - csukuangfj/ and csukuangfj2/ repos on huggingface.co
 *   - k2-fsa/sherpa-onnx GitHub releases (asr-models tag)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { VoiceConfig } from "./config";

// Debug logging — set PI_VOICE_DEBUG=1 to enable (same convention as the other voice modules).
const VOICE_DEBUG = !!process.env.PI_VOICE_DEBUG;
const VOICE_LOG_FILE = path.join(os.tmpdir(), "pi-voice-debug.log");

function debug(...args: unknown[]) {
	if (!VOICE_DEBUG) return;
	const ts = new Date().toISOString().split("T")[1];
	const line = `[voice-local ${ts}] ${args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")}\n`;
	try {
		fs.appendFileSync(VOICE_LOG_FILE, line);
	} catch {
		/* best-effort */
	}
}

// ─── Model catalog ───────────────────────────────────────────────────────────

export interface SherpaModelConfig {
	/**
	 * Decoding mode. `"online"` marks a streaming recogniser, which may only feed the display
	 * preview and never the authoritative pass. Absent means `"offline"`.
	 */
	mode?: "offline" | "online";
	/** Recognizer type for sherpa-onnx */
	type: "whisper" | "moonshine" | "sense_voice" | "nemo_ctc" | "transducer" | "paraformer" | "qwen3_asr";
	/** Map of role → filename within model directory */
	files: Record<string, string>;
	/** Map of role → download URL (HuggingFace or GitHub releases) */
	downloadUrls: Record<string, string>;
	/** Endpointing rules for online models — silence in seconds, utterance length in samples. */
	endpointing?: {
		enableEndpoint: true;
		rule2MinTrailingSilence: number;
		rule3MinUtteranceLength: number;
	};
}

export interface LocalModelInfo {
	id: string;
	name: string;
	/** Human-readable download size */
	size: string;
	/** Download size in bytes (for progress tracking + fitness scoring) */
	sizeBytes: number;
	/** Peak runtime RAM in MB (~2.5x model file size) */
	runtimeRamMB: number;
	notes: string;
	/** Language family — determines which language list to show */
	langSupport:
		| "whisper"
		| "english-only"
		| "parakeet-multi"
		| "sensevoice"
		| "russian-only"
		| "single-ar"
		| "single-zh"
		| "single-ja"
		| "single-ko"
		| "single-uk"
		| "single-vi"
		| "single-es"
		| "bilingual-zh-en"
		| "qwen3";
	/** Device tier: edge (<256 MB), standard (256 MB–1 GB), heavy (>1 GB) */
	tier: "edge" | "standard" | "heavy";
	/** Preferred model — best-in-class for its language/use case. Only these get [recommended]. */
	preferred?: boolean;
	/**
	 * Which selection slot the entry may fill. `"preview"` entries are download-only: they render in
	 * the Models tab but can never become `config.localModel`. Absent means `"final"`.
	 */
	role?: "final" | "preview";
	/** Accuracy rating 1-5 (5 = best). Based on published WER benchmarks. */
	accuracy: 1 | 2 | 3 | 4 | 5;
	/** Speed rating 1-5 (5 = fastest). Based on real-time factor and latency benchmarks. */
	speed: 1 | 2 | 3 | 4 | 5;
	/** sherpa-onnx model configuration — file paths and download URLs */
	sherpaModel: SherpaModelConfig;
}

// HuggingFace base URLs for sherpa-onnx models (verified repos)
const HF1 = "https://huggingface.co/csukuangfj";
const HF2 = "https://huggingface.co/csukuangfj2";
const GH = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models";

// Helper to build HuggingFace resolve URLs
function hf1(repo: string, file: string): string {
	return `${HF1}/${repo}/resolve/main/${file}`;
}
function hf2(repo: string, file: string): string {
	return `${HF2}/${repo}/resolve/main/${file}`;
}

/** The single streaming entry: preview-only, and the only online model in the catalogue. */
export const PREVIEW_MODEL_ID = "streaming-paraformer-bilingual-zh-en";

/**
 * Model catalog — verified against actual HuggingFace repos and file listings.
 *
 * Evidence:
 * - Moonshine v1 (csukuangfj): {preprocess.onnx, encode.int8.onnx, uncached_decode.int8.onnx, cached_decode.int8.onnx, tokens.txt}
 * - Moonshine v2 (csukuangfj2): {encoder_model.ort, decoder_model_merged.ort, tokens.txt}
 * - Whisper (csukuangfj): {SIZE-encoder.int8.onnx, SIZE-decoder.int8.onnx, SIZE-tokens.txt}
 * - SenseVoice (csukuangfj): {model.int8.onnx, tokens.txt}
 * - GigaAM CTC (csukuangfj): {model.int8.onnx, tokens.txt}
 * - Parakeet TDT (csukuangfj): {encoder.int8.onnx, decoder.int8.onnx, joiner.int8.onnx, tokens.txt} — transducer!
 *
 * Note on Moonshine v2 Small/Medium:
 *   These exist ONLY as streaming models (moonshine-ai/moonshine) with a different 5-file
 *   architecture (encoder.ort, frontend.ort, decoder_kv.ort, cross_kv.ort, adapter.ort)
 *   that is incompatible with sherpa-onnx's moonshine recognizer (which expects 2-file
 *   encoder+mergedDecoder or 4-file v1 structure). Only Tiny and Base have non-streaming
 *   variants compatible with sherpa-onnx. See: https://github.com/moonshine-ai/moonshine
 */
export const LOCAL_MODELS: LocalModelInfo[] = [
	// ═══════════════════════════════════════════════════════════════════════
	// TOP PICKS — best overall models, shown first
	// ═══════════════════════════════════════════════════════════════════════
	{
		id: "parakeet-v3",
		name: "Parakeet TDT v3",
		size: "~671 MB",
		sizeBytes: 703_594_496,
		runtimeRamMB: 1675,
		notes: "Best multilingual — 25 languages, auto language detection, WER 6.3%",
		langSupport: "parakeet-multi",
		tier: "standard",
		preferred: true,
		accuracy: 4,
		speed: 4,
		sherpaModel: {
			type: "transducer",
			files: {
				encoder: "encoder.int8.onnx",
				decoder: "decoder.int8.onnx",
				joiner: "joiner.int8.onnx",
				tokens: "tokens.txt",
			},
			downloadUrls: {
				encoder: hf1("sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8", "encoder.int8.onnx"),
				decoder: hf1("sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8", "decoder.int8.onnx"),
				joiner: hf1("sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8", "joiner.int8.onnx"),
				tokens: hf1("sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8", "tokens.txt"),
			},
		},
	},
	{
		id: "parakeet-v2",
		name: "Parakeet TDT v2",
		size: "~661 MB",
		sizeBytes: 693_109_760,
		runtimeRamMB: 1650,
		notes: "Best English — lowest WER (6.0%), fast, NVIDIA NeMo",
		langSupport: "english-only",
		tier: "standard",
		preferred: true,
		accuracy: 5,
		speed: 4,
		sherpaModel: {
			type: "transducer",
			files: {
				encoder: "encoder.int8.onnx",
				decoder: "decoder.int8.onnx",
				joiner: "joiner.int8.onnx",
				tokens: "tokens.txt",
			},
			downloadUrls: {
				encoder: hf1("sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8", "encoder.int8.onnx"),
				decoder: hf1("sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8", "decoder.int8.onnx"),
				joiner: hf1("sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8", "joiner.int8.onnx"),
				tokens: hf1("sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8", "tokens.txt"),
			},
		},
	},
	// ═══════════════════════════════════════════════════════════════════════
	// WHISPER — OpenAI, broadest language support (57 languages)
	// ═══════════════════════════════════════════════════════════════════════
	{
		id: "whisper-turbo",
		name: "Whisper Turbo",
		size: "~1.0 GB",
		sizeBytes: 1_087_373_312,
		runtimeRamMB: 2590,
		notes: "57 languages, good accuracy, faster than Medium and Large",
		langSupport: "whisper",
		tier: "heavy",
		accuracy: 4,
		speed: 2,
		sherpaModel: {
			type: "whisper",
			files: { encoder: "turbo-encoder.int8.onnx", decoder: "turbo-decoder.int8.onnx", tokens: "turbo-tokens.txt" },
			downloadUrls: {
				encoder: hf1("sherpa-onnx-whisper-turbo", "turbo-encoder.int8.onnx"),
				decoder: hf1("sherpa-onnx-whisper-turbo", "turbo-decoder.int8.onnx"),
				tokens: hf1("sherpa-onnx-whisper-turbo", "turbo-tokens.txt"),
			},
		},
	},
	{
		id: "whisper-medium",
		name: "Whisper Medium",
		size: "~946 MB",
		sizeBytes: 991_952_896,
		runtimeRamMB: 2365,
		notes: "57 languages, good accuracy, medium speed",
		langSupport: "whisper",
		tier: "standard",
		accuracy: 4,
		speed: 3,
		sherpaModel: {
			type: "whisper",
			files: { encoder: "medium-encoder.int8.onnx", decoder: "medium-decoder.int8.onnx", tokens: "medium-tokens.txt" },
			downloadUrls: {
				encoder: hf1("sherpa-onnx-whisper-medium", "medium-encoder.int8.onnx"),
				decoder: hf1("sherpa-onnx-whisper-medium", "medium-decoder.int8.onnx"),
				tokens: hf1("sherpa-onnx-whisper-medium", "medium-tokens.txt"),
			},
		},
	},
	{
		id: "whisper-small",
		name: "Whisper Small",
		size: "~375 MB",
		sizeBytes: 393_216_000,
		runtimeRamMB: 940,
		notes: "57 languages, fast, good for low-power devices",
		langSupport: "whisper",
		tier: "standard",
		accuracy: 3,
		speed: 4,
		sherpaModel: {
			type: "whisper",
			files: { encoder: "small-encoder.int8.onnx", decoder: "small-decoder.int8.onnx", tokens: "small-tokens.txt" },
			downloadUrls: {
				encoder: hf1("sherpa-onnx-whisper-small", "small-encoder.int8.onnx"),
				decoder: hf1("sherpa-onnx-whisper-small", "small-decoder.int8.onnx"),
				tokens: hf1("sherpa-onnx-whisper-small", "small-tokens.txt"),
			},
		},
	},
	{
		id: "whisper-large",
		name: "Whisper Large v3",
		size: "~1.8 GB",
		sizeBytes: 1_863_319_552,
		runtimeRamMB: 4440,
		notes: "57 languages, highest Whisper accuracy, slow on CPU",
		langSupport: "whisper",
		tier: "heavy",
		accuracy: 4,
		speed: 1,
		sherpaModel: {
			type: "whisper",
			files: {
				encoder: "large-v3-encoder.int8.onnx",
				decoder: "large-v3-decoder.int8.onnx",
				tokens: "large-v3-tokens.txt",
			},
			downloadUrls: {
				encoder: hf1("sherpa-onnx-whisper-large-v3", "large-v3-encoder.int8.onnx"),
				decoder: hf1("sherpa-onnx-whisper-large-v3", "large-v3-decoder.int8.onnx"),
				tokens: hf1("sherpa-onnx-whisper-large-v3", "large-v3-tokens.txt"),
			},
		},
	},
	// ═══════════════════════════════════════════════════════════════════════
	// MOONSHINE — ultra-fast edge models
	// ═══════════════════════════════════════════════════════════════════════
	{
		id: "moonshine-base",
		name: "Moonshine Base",
		size: "~287 MB",
		sizeBytes: 300_940_288,
		runtimeRamMB: 720,
		notes: "English only, very fast, handles accents well",
		langSupport: "english-only",
		tier: "standard",
		accuracy: 3,
		speed: 5,
		sherpaModel: {
			type: "moonshine",
			files: {
				preprocessor: "preprocess.onnx",
				encoder: "encode.int8.onnx",
				uncachedDecoder: "uncached_decode.int8.onnx",
				cachedDecoder: "cached_decode.int8.onnx",
				tokens: "tokens.txt",
			},
			downloadUrls: {
				preprocessor: hf1("sherpa-onnx-moonshine-base-en-int8", "preprocess.onnx"),
				encoder: hf1("sherpa-onnx-moonshine-base-en-int8", "encode.int8.onnx"),
				uncachedDecoder: hf1("sherpa-onnx-moonshine-base-en-int8", "uncached_decode.int8.onnx"),
				cachedDecoder: hf1("sherpa-onnx-moonshine-base-en-int8", "cached_decode.int8.onnx"),
				tokens: hf1("sherpa-onnx-moonshine-base-en-int8", "tokens.txt"),
			},
		},
	},
	{
		id: "moonshine-tiny",
		name: "Moonshine Tiny",
		size: "~124 MB",
		sizeBytes: 130_023_424,
		runtimeRamMB: 310,
		notes: "English only, 5x faster than Whisper Tiny, low accuracy",
		langSupport: "english-only",
		tier: "edge",
		accuracy: 2,
		speed: 5,
		sherpaModel: {
			type: "moonshine",
			files: {
				preprocessor: "preprocess.onnx",
				encoder: "encode.int8.onnx",
				uncachedDecoder: "uncached_decode.int8.onnx",
				cachedDecoder: "cached_decode.int8.onnx",
				tokens: "tokens.txt",
			},
			downloadUrls: {
				preprocessor: hf1("sherpa-onnx-moonshine-tiny-en-int8", "preprocess.onnx"),
				encoder: hf1("sherpa-onnx-moonshine-tiny-en-int8", "encode.int8.onnx"),
				uncachedDecoder: hf1("sherpa-onnx-moonshine-tiny-en-int8", "uncached_decode.int8.onnx"),
				cachedDecoder: hf1("sherpa-onnx-moonshine-tiny-en-int8", "cached_decode.int8.onnx"),
				tokens: hf1("sherpa-onnx-moonshine-tiny-en-int8", "tokens.txt"),
			},
		},
	},
	{
		id: "moonshine-v2-tiny",
		name: "Moonshine v2 Tiny",
		size: "~43 MB",
		sizeBytes: 45_088_768,
		runtimeRamMB: 110,
		notes: "English only, smallest model, 34ms latency, Raspberry Pi friendly",
		langSupport: "english-only",
		tier: "edge",
		preferred: true,
		accuracy: 2,
		speed: 5,
		sherpaModel: {
			type: "moonshine",
			files: { encoder: "encoder_model.ort", mergedDecoder: "decoder_model_merged.ort", tokens: "tokens.txt" },
			downloadUrls: {
				encoder: hf2("sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27", "encoder_model.ort"),
				mergedDecoder: hf2("sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27", "decoder_model_merged.ort"),
				tokens: hf2("sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27", "tokens.txt"),
			},
		},
	},
	// ═══════════════════════════════════════════════════════════════════════
	// SPECIALIST — best-in-class for specific languages
	// ═══════════════════════════════════════════════════════════════════════
	{
		id: "sensevoice-small",
		name: "SenseVoice Small",
		size: "~228 MB",
		sizeBytes: 239_075_328,
		runtimeRamMB: 570,
		notes: "Chinese, English, Japanese, Korean, Cantonese — very fast",
		langSupport: "sensevoice",
		tier: "edge",
		preferred: true,
		accuracy: 3,
		speed: 5,
		sherpaModel: {
			type: "sense_voice",
			files: { model: "model.int8.onnx", tokens: "tokens.txt" },
			downloadUrls: {
				model: hf1("sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17", "model.int8.onnx"),
				tokens: hf1("sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17", "tokens.txt"),
			},
		},
	},
	{
		id: "gigaam-v3",
		name: "GigaAM v3",
		size: "~225 MB",
		sizeBytes: 235_929_600,
		runtimeRamMB: 560,
		notes: "Russian — fast and accurate, 50% lower WER than Whisper",
		langSupport: "russian-only",
		tier: "edge",
		preferred: true,
		accuracy: 4,
		speed: 4,
		sherpaModel: {
			type: "nemo_ctc",
			files: { model: "model.int8.onnx", tokens: "tokens.txt" },
			downloadUrls: {
				model: hf1("sherpa-onnx-nemo-ctc-giga-am-v3-russian-2025-12-16", "model.int8.onnx"),
				tokens: hf1("sherpa-onnx-nemo-ctc-giga-am-v3-russian-2025-12-16", "tokens.txt"),
			},
		},
	},
	// ═══════════════════════════════════════════════════════════════════════
	// MOONSHINE v2 LANGUAGE VARIANTS — fast, single-language specialized
	// ═══════════════════════════════════════════════════════════════════════
	{
		id: "moonshine-v2-tiny-ja",
		name: "Moonshine v2 Tiny Japanese",
		size: "~69 MB",
		sizeBytes: 72_351_744,
		runtimeRamMB: 175,
		notes: "Japanese-specialized, ultra-fast",
		langSupport: "single-ja",
		tier: "edge",
		accuracy: 3,
		speed: 5,
		sherpaModel: {
			type: "moonshine",
			files: { encoder: "encoder_model.ort", mergedDecoder: "decoder_model_merged.ort", tokens: "tokens.txt" },
			downloadUrls: {
				encoder: hf2("sherpa-onnx-moonshine-tiny-ja-quantized-2026-02-27", "encoder_model.ort"),
				mergedDecoder: hf2("sherpa-onnx-moonshine-tiny-ja-quantized-2026-02-27", "decoder_model_merged.ort"),
				tokens: hf2("sherpa-onnx-moonshine-tiny-ja-quantized-2026-02-27", "tokens.txt"),
			},
		},
	},
	{
		id: "moonshine-v2-tiny-ko",
		name: "Moonshine v2 Tiny Korean",
		size: "~69 MB",
		sizeBytes: 72_351_744,
		runtimeRamMB: 175,
		notes: "Korean-specialized, ultra-fast",
		langSupport: "single-ko",
		tier: "edge",
		accuracy: 3,
		speed: 5,
		sherpaModel: {
			type: "moonshine",
			files: { encoder: "encoder_model.ort", mergedDecoder: "decoder_model_merged.ort", tokens: "tokens.txt" },
			downloadUrls: {
				encoder: hf2("sherpa-onnx-moonshine-tiny-ko-quantized-2026-02-27", "encoder_model.ort"),
				mergedDecoder: hf2("sherpa-onnx-moonshine-tiny-ko-quantized-2026-02-27", "decoder_model_merged.ort"),
				tokens: hf2("sherpa-onnx-moonshine-tiny-ko-quantized-2026-02-27", "tokens.txt"),
			},
		},
	},
	{
		id: "moonshine-v2-base-ar",
		name: "Moonshine v2 Base Arabic",
		size: "~135 MB",
		sizeBytes: 141_557_760,
		runtimeRamMB: 340,
		notes: "Arabic-specialized",
		langSupport: "single-ar",
		tier: "edge",
		accuracy: 3,
		speed: 5,
		sherpaModel: {
			type: "moonshine",
			files: { encoder: "encoder_model.ort", mergedDecoder: "decoder_model_merged.ort", tokens: "tokens.txt" },
			downloadUrls: {
				encoder: hf2("sherpa-onnx-moonshine-base-ar-quantized-2026-02-27", "encoder_model.ort"),
				mergedDecoder: hf2("sherpa-onnx-moonshine-base-ar-quantized-2026-02-27", "decoder_model_merged.ort"),
				tokens: hf2("sherpa-onnx-moonshine-base-ar-quantized-2026-02-27", "tokens.txt"),
			},
		},
	},
	{
		id: "moonshine-v2-base-zh",
		name: "Moonshine v2 Base Chinese",
		size: "~135 MB",
		sizeBytes: 141_557_760,
		runtimeRamMB: 340,
		notes: "Chinese-specialized",
		langSupport: "single-zh",
		tier: "edge",
		accuracy: 3,
		speed: 5,
		sherpaModel: {
			type: "moonshine",
			files: { encoder: "encoder_model.ort", mergedDecoder: "decoder_model_merged.ort", tokens: "tokens.txt" },
			downloadUrls: {
				encoder: hf2("sherpa-onnx-moonshine-base-zh-quantized-2026-02-27", "encoder_model.ort"),
				mergedDecoder: hf2("sherpa-onnx-moonshine-base-zh-quantized-2026-02-27", "decoder_model_merged.ort"),
				tokens: hf2("sherpa-onnx-moonshine-base-zh-quantized-2026-02-27", "tokens.txt"),
			},
		},
	},
	{
		id: "moonshine-v2-base-ja",
		name: "Moonshine v2 Base Japanese",
		size: "~135 MB",
		sizeBytes: 141_557_760,
		runtimeRamMB: 340,
		notes: "Japanese-specialized",
		langSupport: "single-ja",
		tier: "edge",
		accuracy: 3,
		speed: 4,
		sherpaModel: {
			type: "moonshine",
			files: { encoder: "encoder_model.ort", mergedDecoder: "decoder_model_merged.ort", tokens: "tokens.txt" },
			downloadUrls: {
				encoder: hf2("sherpa-onnx-moonshine-base-ja-quantized-2026-02-27", "encoder_model.ort"),
				mergedDecoder: hf2("sherpa-onnx-moonshine-base-ja-quantized-2026-02-27", "decoder_model_merged.ort"),
				tokens: hf2("sherpa-onnx-moonshine-base-ja-quantized-2026-02-27", "tokens.txt"),
			},
		},
	},
	{
		id: "moonshine-v2-base-uk",
		name: "Moonshine v2 Base Ukrainian",
		size: "~135 MB",
		sizeBytes: 141_557_760,
		runtimeRamMB: 340,
		notes: "Ukrainian-specialized",
		langSupport: "single-uk",
		tier: "edge",
		accuracy: 3,
		speed: 4,
		sherpaModel: {
			type: "moonshine",
			files: { encoder: "encoder_model.ort", mergedDecoder: "decoder_model_merged.ort", tokens: "tokens.txt" },
			downloadUrls: {
				encoder: hf2("sherpa-onnx-moonshine-base-uk-quantized-2026-02-27", "encoder_model.ort"),
				mergedDecoder: hf2("sherpa-onnx-moonshine-base-uk-quantized-2026-02-27", "decoder_model_merged.ort"),
				tokens: hf2("sherpa-onnx-moonshine-base-uk-quantized-2026-02-27", "tokens.txt"),
			},
		},
	},
	{
		id: "moonshine-v2-base-vi",
		name: "Moonshine v2 Base Vietnamese",
		size: "~135 MB",
		sizeBytes: 141_557_760,
		runtimeRamMB: 340,
		notes: "Vietnamese-specialized",
		langSupport: "single-vi",
		tier: "edge",
		accuracy: 3,
		speed: 4,
		sherpaModel: {
			type: "moonshine",
			files: { encoder: "encoder_model.ort", mergedDecoder: "decoder_model_merged.ort", tokens: "tokens.txt" },
			downloadUrls: {
				encoder: hf2("sherpa-onnx-moonshine-base-vi-quantized-2026-02-27", "encoder_model.ort"),
				mergedDecoder: hf2("sherpa-onnx-moonshine-base-vi-quantized-2026-02-27", "decoder_model_merged.ort"),
				tokens: hf2("sherpa-onnx-moonshine-base-vi-quantized-2026-02-27", "tokens.txt"),
			},
		},
	},
	{
		id: "moonshine-v2-base-es",
		name: "Moonshine v2 Base Spanish",
		size: "~63 MB",
		sizeBytes: 66_060_288,
		runtimeRamMB: 160,
		notes: "Spanish-specialized",
		langSupport: "single-es",
		tier: "edge",
		accuracy: 3,
		speed: 5,
		sherpaModel: {
			type: "moonshine",
			files: { encoder: "encoder_model.ort", mergedDecoder: "decoder_model_merged.ort", tokens: "tokens.txt" },
			downloadUrls: {
				encoder: hf2("sherpa-onnx-moonshine-base-es-quantized-2026-02-27", "encoder_model.ort"),
				mergedDecoder: hf2("sherpa-onnx-moonshine-base-es-quantized-2026-02-27", "decoder_model_merged.ort"),
				tokens: hf2("sherpa-onnx-moonshine-base-es-quantized-2026-02-27", "tokens.txt"),
			},
		},
	},
	// ═══════════════════════════════════════════════════════════════════════
	// LLM-BASED — Qwen3-ASR and Paraformer (added via local sherpa-onnx patch)
	// ═══════════════════════════════════════════════════════════════════════
	{
		id: "qwen3-asr-0.6b",
		name: "Qwen3 ASR 0.6B",
		size: "~983 MB",
		sizeBytes: 1_031_000_000,
		runtimeRamMB: 2100,
		notes:
			"Qwen (Alibaba) 2026-01 — 30 languages + 22 Chinese dialects, language auto-detection, strong zh/en code-switching. Punctuation per model card (not independently verified on this stack).",
		langSupport: "qwen3",
		tier: "heavy",
		preferred: true,
		accuracy: 4,
		speed: 2,
		sherpaModel: {
			type: "qwen3_asr",
			files: {
				convFrontend: "conv_frontend.onnx",
				encoder: "encoder.int8.onnx",
				decoder: "decoder.int8.onnx",
				tokenizerMerges: "merges.txt",
				tokenizerVocab: "vocab.json",
				tokenizerConfig: "tokenizer_config.json",
			},
			downloadUrls: {
				convFrontend: "https://huggingface.co/pantinor/sherpa-onnx-qwen3-asr-0.6b-int8/resolve/main/conv_frontend.onnx",
				encoder: "https://huggingface.co/pantinor/sherpa-onnx-qwen3-asr-0.6b-int8/resolve/main/encoder.int8.onnx",
				decoder: "https://huggingface.co/pantinor/sherpa-onnx-qwen3-asr-0.6b-int8/resolve/main/decoder.int8.onnx",
				tokenizerMerges:
					"https://huggingface.co/pantinor/sherpa-onnx-qwen3-asr-0.6b-int8/resolve/main/tokenizer/merges.txt",
				tokenizerVocab:
					"https://huggingface.co/pantinor/sherpa-onnx-qwen3-asr-0.6b-int8/resolve/main/tokenizer/vocab.json",
				tokenizerConfig:
					"https://huggingface.co/pantinor/sherpa-onnx-qwen3-asr-0.6b-int8/resolve/main/tokenizer/tokenizer_config.json",
			},
		},
	},
	{
		id: "paraformer-zh",
		name: "Paraformer zh (bilingual)",
		size: "~238 MB",
		sizeBytes: 249_000_000,
		runtimeRamMB: 620,
		notes:
			"Alibaba speech_paraformer-large-vad-punc 2023-09 — zh/en bilingual auto-detect. -punc variant nominally adds punctuation (per model card, not independently verified on this stack).",
		langSupport: "bilingual-zh-en",
		tier: "standard",
		preferred: true,
		accuracy: 4,
		speed: 5,
		sherpaModel: {
			type: "paraformer",
			files: { model: "model.int8.onnx", tokens: "tokens.txt" },
			downloadUrls: {
				model: hf1("sherpa-onnx-paraformer-zh-2023-09-14", "model.int8.onnx"),
				tokens: hf1("sherpa-onnx-paraformer-zh-2023-09-14", "tokens.txt"),
			},
		},
	},
	// ═══════════════════════════════════════════════════════════════════════
	// PREVIEW ONLY — streaming model for the on-screen draft, never the final pass
	// ═══════════════════════════════════════════════════════════════════════
	{
		id: PREVIEW_MODEL_ID,
		name: "Streaming Paraformer (bilingual zh-en)",
		size: "226 MB",
		sizeBytes: 237_202_501,
		runtimeRamMB: 300,
		notes:
			"Streaming preview only — never selectable as the final model. Live draft while you speak; the final text still comes from your offline model.",
		langSupport: "bilingual-zh-en",
		tier: "edge",
		role: "preview",
		accuracy: 4,
		speed: 5,
		sherpaModel: {
			mode: "online",
			type: "paraformer",
			files: {
				encoder: "encoder.int8.onnx",
				decoder: "decoder.int8.onnx",
				tokens: "tokens.txt",
			},
			downloadUrls: {
				encoder: hf1("sherpa-onnx-streaming-paraformer-bilingual-zh-en", "encoder.int8.onnx"),
				decoder: hf1("sherpa-onnx-streaming-paraformer-bilingual-zh-en", "decoder.int8.onnx"),
				tokens: hf1("sherpa-onnx-streaming-paraformer-bilingual-zh-en", "tokens.txt"),
			},
			endpointing: {
				enableEndpoint: true,
				rule2MinTrailingSilence: 1.2,
				rule3MinUtteranceLength: 600,
			},
		},
	},
];

export const DEFAULT_LOCAL_MODEL = "parakeet-v3";

// ─── Role selectors ──────────────────────────────────────────────────────────

/**
 * Catalogue entries that may produce the authoritative transcript (anything not marked
 * `role: "preview"`). Every final-model consumer — pickers, auto-recommendation, the
 * post-delete fallback — must select through this instead of filtering inline.
 */
export function finalModels(): LocalModelInfo[] {
	return LOCAL_MODELS.filter((model) => (model.role ?? "final") === "final");
}

/** The streaming entry that may only feed the display preview. */
export function previewModel(): LocalModelInfo {
	const model = LOCAL_MODELS.find((entry) => entry.id === PREVIEW_MODEL_ID);
	if (!model) throw new Error(`Preview model ${PREVIEW_MODEL_ID} is missing from LOCAL_MODELS`);
	return model;
}

// ─── Language support per model family ───────────────────────────────────────
// Whisper uses simple ISO 639-1 codes (no regional variants like "en-AU").
// Parakeet V2 is English-only. Parakeet V3 shares Whisper's language set.

export interface LocalLangEntry {
	name: string;
	code: string;
	popular?: boolean;
}

const WHISPER_LANGUAGES: LocalLangEntry[] = [
	// Popular — shown first
	{ name: "English", code: "en", popular: true },
	{ name: "Hindi", code: "hi", popular: true },
	{ name: "Spanish", code: "es", popular: true },
	{ name: "French", code: "fr", popular: true },
	{ name: "German", code: "de", popular: true },
	{ name: "Portuguese", code: "pt", popular: true },
	{ name: "Japanese", code: "ja", popular: true },
	{ name: "Korean", code: "ko", popular: true },
	{ name: "Chinese", code: "zh", popular: true },
	{ name: "Arabic", code: "ar", popular: true },
	{ name: "Russian", code: "ru", popular: true },
	{ name: "Italian", code: "it", popular: true },
	// All others alphabetically
	{ name: "Afrikaans", code: "af" },
	{ name: "Armenian", code: "hy" },
	{ name: "Azerbaijani", code: "az" },
	{ name: "Belarusian", code: "be" },
	{ name: "Bengali", code: "bn" },
	{ name: "Bosnian", code: "bs" },
	{ name: "Bulgarian", code: "bg" },
	{ name: "Catalan", code: "ca" },
	{ name: "Croatian", code: "hr" },
	{ name: "Czech", code: "cs" },
	{ name: "Danish", code: "da" },
	{ name: "Dutch", code: "nl" },
	{ name: "Estonian", code: "et" },
	{ name: "Finnish", code: "fi" },
	{ name: "Galician", code: "gl" },
	{ name: "Greek", code: "el" },
	{ name: "Hebrew", code: "he" },
	{ name: "Hungarian", code: "hu" },
	{ name: "Icelandic", code: "is" },
	{ name: "Indonesian", code: "id" },
	{ name: "Kannada", code: "kn" },
	{ name: "Kazakh", code: "kk" },
	{ name: "Latvian", code: "lv" },
	{ name: "Lithuanian", code: "lt" },
	{ name: "Macedonian", code: "mk" },
	{ name: "Malay", code: "ms" },
	{ name: "Maori", code: "mi" },
	{ name: "Marathi", code: "mr" },
	{ name: "Nepali", code: "ne" },
	{ name: "Norwegian", code: "no" },
	{ name: "Persian", code: "fa" },
	{ name: "Polish", code: "pl" },
	{ name: "Romanian", code: "ro" },
	{ name: "Serbian", code: "sr" },
	{ name: "Slovak", code: "sk" },
	{ name: "Slovenian", code: "sl" },
	{ name: "Swahili", code: "sw" },
	{ name: "Swedish", code: "sv" },
	{ name: "Tagalog", code: "tl" },
	{ name: "Tamil", code: "ta" },
	{ name: "Telugu", code: "te" },
	{ name: "Thai", code: "th" },
	{ name: "Turkish", code: "tr" },
	{ name: "Ukrainian", code: "uk" },
	{ name: "Urdu", code: "ur" },
	{ name: "Vietnamese", code: "vi" },
	{ name: "Welsh", code: "cy" },
];

const ENGLISH_ONLY_LANGUAGES: LocalLangEntry[] = [{ name: "English", code: "en", popular: true }];

const SENSEVOICE_LANGUAGES: LocalLangEntry[] = [
	{ name: "Chinese (Mandarin)", code: "zh", popular: true },
	{ name: "English", code: "en", popular: true },
	{ name: "Japanese", code: "ja", popular: true },
	{ name: "Korean", code: "ko", popular: true },
	{ name: "Cantonese", code: "yue", popular: true },
];

const RUSSIAN_ONLY_LANGUAGES: LocalLangEntry[] = [{ name: "Russian", code: "ru", popular: true }];

/** Paraformer zh — actual capability is zh/en bilingual (auto-detect). */
const BILINGUAL_ZH_EN_LANGUAGES: LocalLangEntry[] = [
	{ name: "Chinese", code: "zh", popular: true },
	{ name: "English", code: "en", popular: true },
];

/**
 * Qwen3-ASR 0.6B — language auto-detection across 30 languages + 22 Chinese
 * dialects (verified against Qwen/sherpa-onnx published specs; the full 30-language
 * list is not enumerated here, zh/en shown as the primary use cases).
 */
const QWEN3_LANGUAGES: LocalLangEntry[] = [
	{ name: "Chinese", code: "zh", popular: true },
	{ name: "English", code: "en", popular: true },
];

// Single-language lists for Moonshine Flavors
const SINGLE_LANG: Record<string, LocalLangEntry[]> = {
	ar: [{ name: "Arabic", code: "ar", popular: true }],
	zh: [{ name: "Chinese", code: "zh", popular: true }],
	ja: [{ name: "Japanese", code: "ja", popular: true }],
	ko: [{ name: "Korean", code: "ko", popular: true }],
	uk: [{ name: "Ukrainian", code: "uk", popular: true }],
	vi: [{ name: "Vietnamese", code: "vi", popular: true }],
	es: [{ name: "Spanish", code: "es", popular: true }],
};

/**
 * Get the supported language list for a local model.
 * Returns englishOnly=true when only one language is supported (no picker needed).
 */
/**
 * Shared langSupport → language-list map. BOTH the UI (getLanguagesForLocalModel)
 * and the device recommender (device.ts modelSupportsLanguage) read from here,
 * so a new langSupport value can never drift one side fail-open again.
 *
 * Unknown langSupport values (forward/custom models) conservatively resolve to
 * no languages: an unregistered capability must NOT silently mean "all".
 */
export function languagesForLangSupport(langSupport: LocalModelInfo["langSupport"]): LocalLangEntry[] {
	switch (langSupport) {
		case "english-only":
			return ENGLISH_ONLY_LANGUAGES;
		case "russian-only":
			return RUSSIAN_ONLY_LANGUAGES;
		case "single-ar":
			return SINGLE_LANG.ar!;
		case "single-zh":
			return SINGLE_LANG.zh!;
		case "single-ja":
			return SINGLE_LANG.ja!;
		case "single-ko":
			return SINGLE_LANG.ko!;
		case "single-uk":
			return SINGLE_LANG.uk!;
		case "single-vi":
			return SINGLE_LANG.vi!;
		case "single-es":
			return SINGLE_LANG.es!;
		case "sensevoice":
			return SENSEVOICE_LANGUAGES;
		case "bilingual-zh-en":
			return BILINGUAL_ZH_EN_LANGUAGES;
		case "qwen3":
			return QWEN3_LANGUAGES;
		case "whisper":
		case "parakeet-multi":
			return WHISPER_LANGUAGES;
		default:
			// Unregistered language families conservatively resolve to empty (assume no languages)
			return [];
	}
}

export function getLanguagesForLocalModel(modelId: string): { languages: LocalLangEntry[]; englishOnly: boolean } {
	const model = LOCAL_MODELS.find((m) => m.id === modelId);
	// UI is lenient with unknown model ids — show the full Whisper list for manual selection.
	// (Capability checks go through device.modelSupportsLanguage, which uses the shared table by langSupport.)
	if (!model) return { languages: WHISPER_LANGUAGES, englishOnly: false };
	const languages = languagesForLangSupport(model.langSupport);
	return { languages, englishOnly: languages.length <= 1 };
}

/**
 * Check if a language code is supported by a local model.
 * Used to validate /voice-language changes against current model.
 */
export function isLanguageSupportedByModel(modelId: string, langCode: string): boolean {
	const { languages } = getLanguagesForLocalModel(modelId);
	// Match base code (e.g. "en" matches "en", regional variants stripped for local)
	const baseCode = langCode.split("-")[0];
	return languages.some((l) => l.code === baseCode || l.code === langCode);
}

/**
 * Find display name for a language code in local model context.
 */
export function localLanguageDisplayName(code: string): string {
	// Check all language lists
	const allLists = [
		WHISPER_LANGUAGES,
		SENSEVOICE_LANGUAGES,
		BILINGUAL_ZH_EN_LANGUAGES,
		QWEN3_LANGUAGES,
		RUSSIAN_ONLY_LANGUAGES,
		...Object.values(SINGLE_LANG),
	];
	for (const list of allLists) {
		const entry = list.find((l) => l.code === code);
		if (entry) return `${entry.name} (${entry.code})`;
	}
	return code;
}

// ─── Local session type ──────────────────────────────────────────────────────

/**
 * One recording's outcome. A final pass that cannot finish is a *recording outcome* — the speech
 * happened and the user may already have seen it — so it travels through `onDone` as `failed` and
 * never through `onError`: only a failed result can become "unconfirmed" downstream, where the
 * preview's words are kept and the missing authoritative text is reported. `onError` stays reserved
 * for capture and programming errors, which have no transcript to keep.
 */
export type LocalSessionResult = { kind: "ok"; text: string; hadSpeech: boolean } | { kind: "failed"; message: string };

/**
 * Callbacks a local recording session accepts. `onSegment` and `onAudioChunk` are optional, so callers
 * that do not pipeline segments or preview audio keep today's transcript-only behaviour.
 */
export interface LocalSessionCallbacks {
	onDone: (result: LocalSessionResult, meta: { hadAudio: boolean }) => void;
	/** Genuine capture/programming errors, never a recording outcome (see `LocalSessionResult`). */
	onError: (err: string) => void;
	/**
	 * Called as each recogniser segment decodes, before the next segment starts, with the
	 * segment's zero-based index. Observational: it never changes the transcript.
	 */
	onSegment?: (text: string, index: number) => void;
	/**
	 * Called synchronously for every captured chunk *before* it is buffered, with the very buffer the
	 * final pass will transcribe. Purely observational: a throwing callback is swallowed, so capture
	 * can never fail because of a preview.
	 */
	onAudioChunk?: (chunk: Buffer) => void;
}

export interface LocalSession {
	recProcess: ChildProcess;
	audioChunks: Buffer[];
	/** No longer accepting audio: settled, or aborted. */
	closed: boolean;
	hadAudioData: boolean;
	/** A stop or abort has begun, so a child close from now on is expected (spec §5.1). */
	stopping: boolean;
	/** A terminal result or error has been delivered; every later settle is dropped. */
	settled: boolean;
	onDone: (result: LocalSessionResult, meta: { hadAudio: boolean }) => void;
	onError: (err: string) => void;
	/** Optional per-segment observer; forwarded to the in-process recogniser on stop. */
	onSegment?: (text: string, index: number) => void;
	/** Optional capture fan-out; see `LocalSessionCallbacks.onAudioChunk`. */
	onAudioChunk?: (chunk: Buffer) => void;
}

// ─── WAV encoding ────────────────────────────────────────────────────────────

/** Capture format every local model expects: 16 kHz, mono, 16-bit signed LE. */
export const SAMPLE_RATE = 16000;
export const CHANNELS = 1;

// ─── Session lifecycle ───────────────────────────────────────────────────────

/**
 * Deliver the session's one terminal result. Every later settle is dropped: a recording has exactly
 * one outcome, whether the second attempt comes from a paired `error`/`close`, from a close and a
 * stop racing, or from a stop that lost the race (spec §5.1).
 */
function settle(session: LocalSession, result: LocalSessionResult, meta: { hadAudio: boolean }): void {
	if (session.settled) return;
	session.settled = true;
	session.closed = true;
	session.onDone(result, meta);
}

/** Deliver the session's one terminal capture error — not a recording outcome, so never a result. */
function fail(session: LocalSession, message: string): void {
	if (session.settled) return;
	session.settled = true;
	session.closed = true;
	session.onError(message);
}

/** Why the capture child ended, for the message the user sees. */
function describeCaptureExit(code: number | null, signal: NodeJS.Signals | null): string {
	if (signal) return `signal ${signal}`;
	if (code !== null) return `exit code ${code}`;
	return "unknown reason";
}

/**
 * Start a local recording session. Audio is buffered in memory.
 * Transcription happens when stopLocalSession() is called.
 */
export function startLocalSession(recProcess: ChildProcess, callbacks: LocalSessionCallbacks): LocalSession {
	/** A throwing audio observer is reported once per recording, not once per chunk. */
	let warnedOnAudioChunk = false;

	const session: LocalSession = {
		recProcess,
		audioChunks: [],
		closed: false,
		hadAudioData: false,
		stopping: false,
		settled: false,
		onDone: callbacks.onDone,
		onError: callbacks.onError,
		onSegment: callbacks.onSegment,
		onAudioChunk: callbacks.onAudioChunk,
	};

	recProcess.stdout?.on("data", (chunk: Buffer) => {
		if (session.closed) return;
		// Fan out *before* buffering, with the same buffer the final pass will get: the preview must
		// see every sample in order, and a throwing observer must never cost capture a chunk.
		if (session.onAudioChunk) {
			try {
				session.onAudioChunk(chunk);
			} catch (err) {
				if (!warnedOnAudioChunk) {
					warnedOnAudioChunk = true;
					debug("onAudioChunk threw — capture continues:", err instanceof Error ? err.message : String(err));
				}
			}
		}
		session.hadAudioData = true;
		session.audioChunks.push(chunk);
	});

	recProcess.stderr?.on("data", (d: Buffer) => {
		const msg = d.toString().trim();
		if (msg.includes("buffer overrun") || msg.includes("Discarding") || msg.includes("Last message repeated")) return;
	});

	recProcess.on("error", (err) => {
		// A capture error is not a recording outcome: nothing was transcribed, so it keeps the
		// capture-error channel, and the close that follows it is expected rather than a second one.
		if (session.closed) return;
		session.stopping = true;
		fail(session, `Audio capture error: ${err.message}`);
	});

	// An unexpected close/exit ends the recording where it stands (spec §5.1): capture is gone, so
	// the user must not have to stop a recording that is already dead. Both events are registered
	// because either can arrive first; the single `settled` guard makes the pair one terminal.
	const onCaptureExit = (code: number | null, signal: NodeJS.Signals | null) => {
		// `settle` marks the session closed, so `closed` also covers a terminal that already landed.
		if (session.closed || session.stopping) return;
		session.stopping = true;
		settle(
			session,
			{ kind: "failed", message: `Audio capture stopped unexpectedly (${describeCaptureExit(code, signal)})` },
			{ hadAudio: session.hadAudioData }
		);
	};
	recProcess.on("close", onCaptureExit);
	recProcess.on("exit", onCaptureExit);

	return session;
}

/**
 * Stop recording and transcribe the buffered audio in-process via sherpa-onnx.
 */
export async function stopLocalSession(session: LocalSession, config: VoiceConfig): Promise<void> {
	if (session.closed) return;

	// From here on the child's exit is this stop's own doing, not an unexpected capture death.
	session.stopping = true;

	// Stop recording
	try {
		session.recProcess.kill("SIGTERM");
	} catch {}

	// Wait briefly for any remaining audio data
	await new Promise((r) => setTimeout(r, 200));

	// Recheck after await — abort or an unexpected close may have fired during the 200ms wait.
	// Still settle so the voice state machine transitions back to idle; `settle` drops it when the
	// session already delivered its terminal.
	if (session.closed) {
		settle(session, { kind: "ok", text: "", hadSpeech: false }, { hadAudio: false });
		return;
	}

	const pcmData = Buffer.concat(session.audioChunks);
	// Free individual chunk references during transcription
	session.audioChunks.length = 0;

	if (pcmData.length === 0) {
		settle(session, { kind: "ok", text: "", hadSpeech: false }, { hadAudio: false });
		return;
	}

	try {
		const text = await transcribeWithTimeout(pcmData, config, session.onSegment);

		// Recheck after await — abort or an unexpected close may have fired during transcription.
		// Still settle so the state machine transitions back to idle.
		if (session.closed) {
			settle(session, { kind: "ok", text: "", hadSpeech: false }, { hadAudio: false });
			return;
		}

		settle(session, { kind: "ok", text, hadSpeech: text.trim().length > 0 }, { hadAudio: true });
	} catch (err: any) {
		const message = err?.message || String(err);
		if (session.closed) {
			// Session was aborted during transcription — still surface the error so the user knows
			// transcription failed, not just "no speech". An abort is not a recording outcome, so it
			// stays out of the result union: aborting must write nothing.
			fail(session, `Local transcription aborted: ${message}`);
			return;
		}
		// The words the user already saw in the preview are why this is a result and not an error:
		// only `failed` can become `finalText: null` downstream.
		settle(session, { kind: "failed", message: `Local transcription failed: ${message}` }, { hadAudio: true });
	}
}

/** Abort a local session — kill recording, discard audio. */
export function abortLocalSession(session: LocalSession | null): void {
	if (!session || session.closed) return;
	session.closed = true;
	session.stopping = true;
	try {
		session.recProcess.kill("SIGKILL");
	} catch {}
}

// ─── In-process transcription via sherpa-onnx ────────────────────────────────

/** The in-process final pass, bounded so a hung recogniser cannot wedge the recording. */
async function transcribeWithTimeout(
	pcmData: Buffer,
	config: VoiceConfig,
	onSegment?: (text: string, index: number) => void
): Promise<string> {
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			transcribeInProcess(pcmData, config, onSegment),
			new Promise<never>((_, reject) => {
				timeoutHandle = setTimeout(() => reject(new Error("Transcription timed out (120s)")), 120_000);
			}),
		]);
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
	}
}

/**
 * Transcribe PCM audio using sherpa-onnx in-process.
 * Auto-downloads model on first use.
 */
async function transcribeInProcess(
	pcmData: Buffer,
	config: VoiceConfig,
	onSegment?: (text: string, index: number) => void
): Promise<string> {
	const { initSherpa, isSherpaAvailable, getSherpaError, getOrCreateRecognizer, transcribeBufferSegmented } =
		await import("./sherpa-engine");
	const { ensureModelDownloaded } = await import("./model-download");

	// Initialize sherpa if needed
	if (!isSherpaAvailable()) {
		const ok = await initSherpa();
		if (!ok) {
			throw new Error(`sherpa-onnx could not be loaded: ${getSherpaError() || "unknown error"}`);
		}
	}

	const model = LOCAL_MODELS.find((m) => m.id === (config.localModel || DEFAULT_LOCAL_MODEL));
	if (!model) throw new Error(`Unknown model: ${config.localModel}`);

	// Ensure model files are downloaded
	const modelDir = await ensureModelDownloaded(model.id, model.sherpaModel.downloadUrls, model.sizeBytes);

	// Create/reuse recognizer and transcribe
	const recognizer = getOrCreateRecognizer(model, modelDir, config.language || "en");
	// Every in-process model decodes long audio in VAD-sized pieces and reports each piece through
	// `onSegment` as it decodes, in order; audio at or below the segment threshold takes the same
	// single-decode fast path as before and the concatenation is unchanged.
	return transcribeBufferSegmented(pcmData, recognizer, undefined, onSegment);
}
