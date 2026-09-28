import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LOCAL_MODELS } from "../extensions/voice/local";
import { getModelsDir } from "../extensions/voice/model-download";
import {
	ensurePunctuationModel,
	isPunctuationModelReady,
	PUNCTUATION_MODEL,
	punctuationModelPath,
} from "../extensions/voice/punctuation-model";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-voice-punct-model-test-"));
	tempDirs.push(dir);
	return dir;
}

/** Write every catalogue file into `dir` — with the wrong bytes, so no digest can match. */
function writeWrongModelFiles(dir: string): void {
	for (const name of Object.keys(PUNCTUATION_MODEL.sha256)) {
		fs.writeFileSync(path.join(dir, name), "not the measured bytes");
	}
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("PUNCTUATION_MODEL catalogue", () => {
	test("names the files the downloader fetches, keyed by the names it derives from the URLs", () => {
		expect(PUNCTUATION_MODEL.id).toBe("punct-ct-transformer-zh-en");
		expect(Object.keys(PUNCTUATION_MODEL.files).sort()).toEqual(["model", "tokens"]);

		// `sha256` is keyed by file name, and the downloader names files after the URL basename —
		// the two must agree or the digest would be looked up under a path that never exists.
		const names = Object.values(PUNCTUATION_MODEL.files).map((url) => path.basename(new URL(url).pathname));
		expect(Object.keys(PUNCTUATION_MODEL.sha256).sort()).toEqual([...names].sort());

		for (const url of Object.values(PUNCTUATION_MODEL.files)) {
			expect(url).toStartWith("https://");
			expect(() => new URL(url)).not.toThrow();
		}
		for (const digest of Object.values(PUNCTUATION_MODEL.sha256)) {
			expect(digest).toMatch(/^[0-9a-f]{64}$/);
		}
	});

	test("is not a recogniser — it must never reach LOCAL_MODELS", () => {
		expect(LOCAL_MODELS.some((model) => model.id === PUNCTUATION_MODEL.id)).toBe(false);
	});

	test("sizeBytes covers both files, i.e. the 285 MB the notice quotes", () => {
		expect(PUNCTUATION_MODEL.sizeBytes).toBeGreaterThan(280 * 1024 * 1024);
		expect(PUNCTUATION_MODEL.sizeBytes).toBeLessThan(300 * 1024 * 1024);
	});
});

describe("punctuationModelPath", () => {
	test("resolves the model id under getModelsDir()", () => {
		expect(punctuationModelPath()).toBe(path.join(getModelsDir(), PUNCTUATION_MODEL.id));
	});
});

describe("isPunctuationModelReady", () => {
	test("reports not ready when the model directory does not exist", () => {
		expect(isPunctuationModelReady(path.join(makeTempDir(), "never-downloaded"))).toBe(false);
	});

	test("reports not ready when the catalogue files are missing", () => {
		expect(isPunctuationModelReady(makeTempDir())).toBe(false);
	});

	test("reports not ready on a digest mismatch — the file is not used", () => {
		const dir = makeTempDir();
		writeWrongModelFiles(dir);
		expect(isPunctuationModelReady(dir)).toBe(false);
	});
});

describe("ensurePunctuationModel", () => {
	test("returns false instead of throwing when the transfer fails", async () => {
		const result = await ensurePunctuationModel({
			modelDir: makeTempDir(),
			download: async () => {
				throw new Error("network down");
			},
		});
		expect(result).toBe(false);
	});

	test("returns false when the transfer lands files whose digests do not match", async () => {
		const dir = makeTempDir();
		let transfers = 0;
		const result = await ensurePunctuationModel({
			modelDir: dir,
			download: async () => {
				transfers++;
				writeWrongModelFiles(dir);
				return dir;
			},
		});
		expect(result).toBe(false);
		expect(transfers).toBe(1);
	});

	test("shares one transfer between concurrent callers", async () => {
		const dir = makeTempDir();
		let transfers = 0;
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const download = async () => {
			transfers++;
			await gate;
			throw new Error("network down");
		};

		const first = ensurePunctuationModel({ modelDir: dir, download });
		const second = ensurePunctuationModel({ modelDir: dir, download });
		release();

		expect(await Promise.all([first, second])).toEqual([false, false]);
		expect(transfers).toBe(1);
	});
});
