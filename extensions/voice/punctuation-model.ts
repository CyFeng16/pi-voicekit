/**
 * Punctuation model catalogue and file lifecycle.
 *
 * The sherpa-onnx CT-Transformer punctuation model is not a recogniser, so it does not belong in
 * `local.ts`'s `LOCAL_MODELS` (every entry there carries recogniser-only fields, feeds the device
 * scoring and appears in the `/voice-models` rows). It lives here instead: the download reuses the
 * recognisers' `ensureModelDownloaded` and directory layout, and the SHA-256 of each file is
 * recorded from the measured download so a truncated or corrupt transfer is never handed to the
 * engine (spec §4.2).
 *
 * Storage: `<getModelsDir()>/<PUNCTUATION_MODEL.id>/`.
 *
 * Spec: docs/superpowers/specs/2026-09-28-punctuation-replacing-llm-polish-design.md §4.2
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureModelDownloaded, getModelDir } from "./model-download";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PunctuationModelInfo {
	id: string;
	/** role → URL. The downloader names each file after the URL's basename. */
	files: Record<string, string>;
	/** Total transfer size in bytes, for progress reporting. */
	sizeBytes: number;
	/** File name → expected SHA-256, recorded from the measured download (2026-09-28). */
	sha256: Record<string, string>;
}

// ─── Catalogue ───────────────────────────────────────────────────────────────

const BASE_URL =
	"https://huggingface.co/csukuangfj/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12/resolve/main";

export const PUNCTUATION_MODEL: PunctuationModelInfo = {
	id: "punct-ct-transformer-zh-en",
	files: {
		model: `${BASE_URL}/model.onnx`,
		tokens: `${BASE_URL}/tokens.json`,
	},
	// 294_372_519 (model.onnx) + 4_207_480 (tokens.json), measured 2026-09-28. Both files are
	// still served at those sizes by the repository above (repo commit 432aeba6, 2026-09-28), and
	// the recorded model digest is the digest the repository publishes for that revision.
	sizeBytes: 298_579_999,
	sha256: {
		"model.onnx": "e93593a6dbd69a07f8734ef269dbe861a379755f8d1c8354719432116f2c44bd",
		"tokens.json": "c960ab87bccea4aa15cf49a59f71973c2c330b46668048cd8da253749ec71ee3",
	},
};

// ─── Paths ───────────────────────────────────────────────────────────────────

/** Directory that holds the model's files — `<getModelsDir()>/<id>`. */
export function punctuationModelPath(): string {
	return getModelDir(PUNCTUATION_MODEL.id);
}

/** Absolute path of a catalogue file inside `modelDir` (roles: `model`, `tokens`). */
export function punctuationModelFilePath(role: string, modelDir: string = punctuationModelPath()): string {
	const url = PUNCTUATION_MODEL.files[role];
	if (!url) throw new Error(`Unknown punctuation model file role: ${role}`);
	return path.join(modelDir, path.basename(new URL(url).pathname));
}

// ─── Integrity ───────────────────────────────────────────────────────────────

/**
 * File stamps (size + mtime) of the directories whose digests were verified in this process.
 * Hashing the model's files costs about 150 ms of CPU (measured 2026-09-28), so a verified
 * directory stays verified while its files are unchanged — the dictation path may ask on every
 * recording. A deleted or replaced file changes its stamp and is checked again.
 */
const verifiedStamps = new Map<string, string[]>();

/**
 * True when every catalogue file exists under `modelDir` and matches its recorded SHA-256.
 * A digest mismatch reports the model as absent: the caller must not use the file (spec §4.2).
 *
 * The first call over files that have not been verified in this process hashes them (about
 * 150 ms for the model), so the dictation path should let `preparePunctuation()` do that work in
 * the background and use this only to report state.
 */
export function isPunctuationModelReady(modelDir: string = punctuationModelPath()): boolean {
	const names = Object.keys(PUNCTUATION_MODEL.sha256);
	const stamps: string[] = [];
	for (const name of names) {
		const stamp = fileStamp(path.join(modelDir, name));
		if (stamp === undefined) return false;
		stamps.push(stamp);
	}

	const cached = verifiedStamps.get(modelDir);
	if (cached?.length === stamps.length && cached.every((stamp, index) => stamp === stamps[index])) {
		return true;
	}

	for (const name of names) {
		if (sha256File(path.join(modelDir, name)) !== PUNCTUATION_MODEL.sha256[name]) return false;
	}

	verifiedStamps.set(modelDir, stamps);
	return true;
}

/** `size:mtimeMs` of a readable file, or undefined when it cannot be read. */
function fileStamp(filePath: string): string | undefined {
	try {
		const stat = fs.statSync(filePath);
		return `${stat.size}:${stat.mtimeMs}`;
	} catch {
		return undefined;
	}
}

/** SHA-256 of a file as lowercase hex, or undefined when the file cannot be read. */
function sha256File(filePath: string): string | undefined {
	try {
		const hash = createHash("sha256");
		const fd = fs.openSync(filePath, "r");
		try {
			const buffer = Buffer.allocUnsafe(1 << 20);
			let read = 0;
			while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
				hash.update(buffer.subarray(0, read));
			}
		} finally {
			fs.closeSync(fd);
		}
		return hash.digest("hex");
	} catch {
		return undefined;
	}
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

/** Transfer used when a catalogue file is missing — `ensureModelDownloaded` outside tests. */
export type PunctuationModelDownload = (
	modelId: string,
	files: Record<string, string>,
	sizeBytes: number
) => Promise<string>;

export interface EnsurePunctuationModelOptions {
	/** Test seam — directory to verify. Defaults to `punctuationModelPath()`. */
	modelDir?: string;
	/** Test seam — transfer used when files are missing. Defaults to `ensureModelDownloaded`. */
	download?: PunctuationModelDownload;
}

/** The transfer in flight, so concurrent callers join it instead of restarting it. */
let ensureInFlight: Promise<boolean> | null = null;

/**
 * Make sure the model's files are present and verified, downloading them when they are not.
 *
 * Never throws: `false` means "no usable model" and the caller keeps the raw transcript
 * (spec invariant 2). Concurrent callers — a dictation finishes on every recording — share one
 * transfer; a transfer that fails or lands corrupt files is retried on the next call.
 */
export async function ensurePunctuationModel(options: EnsurePunctuationModelOptions = {}): Promise<boolean> {
	const modelDir = options.modelDir ?? punctuationModelPath();
	if (isPunctuationModelReady(modelDir)) return true;

	ensureInFlight ??= transferPunctuationModel(modelDir, options).finally(() => {
		ensureInFlight = null;
	});
	return ensureInFlight;
}

async function transferPunctuationModel(modelDir: string, options: EnsurePunctuationModelOptions): Promise<boolean> {
	try {
		const download = options.download ?? ensureModelDownloaded;
		await download(PUNCTUATION_MODEL.id, PUNCTUATION_MODEL.files, PUNCTUATION_MODEL.sizeBytes);
	} catch {
		return false;
	}
	return isPunctuationModelReady(modelDir);
}
