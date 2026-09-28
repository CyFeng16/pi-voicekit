import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/** Everything npm is allowed to carry. Anything else in the tree stays on GitHub. */
const PUBLISHED_FILES = ["extensions", "README.md", "LICENSE", "package.json"];

/** Directories that hold measuring equipment rather than product code. */
const NOT_PUBLISHED = ["bench", "tests", "scripts", "docs", "i18n", "assets"];

interface BenchSlice {
	id: string;
	layer: string;
	language: string;
	dataset: string;
	split: string;
	revision: string;
	license: string;
	source: string;
	select: { kind: string; count: number };
	audioColumn: string;
	textColumns: string[];
	referenceRule: string;
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function readBenchSlices(): BenchSlice[] {
	return readFileSync("bench/manifest.jsonl", "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as BenchSlice);
}

describe("npm publish surface", () => {
	test("package.json publishes exactly the extension, README, LICENSE and manifest", () => {
		expect(readJson("package.json").files).toEqual(PUBLISHED_FILES);
	});

	test("no measuring directory is reachable from the published file list", () => {
		const published = (readJson("package.json").files as string[]).join("\n");

		for (const directory of NOT_PUBLISHED) {
			expect(published).not.toContain(directory);
		}
	});

	test("benchmark corpora are git-ignored so they cannot be committed", () => {
		const rules = readFileSync("bench/.gitignore", "utf8")
			.split("\n")
			.map((line) => line.trim());

		expect(rules).toContain("data/");
	});

	test("the root ignore file covers the fetched corpora too", () => {
		const rules = readFileSync(".gitignore", "utf8")
			.split("\n")
			.map((line) => line.trim());

		expect(rules).toContain("bench/data/");
	});
});

describe("benchmark manifest contract", () => {
	test("every slice pins a revision, a licence and a bounded selection", () => {
		const slices = readBenchSlices();
		expect(slices.length).toBeGreaterThan(0);

		for (const slice of slices) {
			// A moving revision would make yesterday's number unreproducible.
			expect(slice.revision).toMatch(/^[0-9a-f]{40}$/);
			expect(slice.license.length).toBeGreaterThan(0);
			expect(slice.source).toMatch(/^https:\/\//);
			expect(slice.dataset.length).toBeGreaterThan(0);
			expect(slice.split.length).toBeGreaterThan(0);
			expect(["first", "first-per-label"]).toContain(slice.select.kind);
			expect(slice.select.count).toBeGreaterThan(0);
			expect(slice.audioColumn.length).toBeGreaterThan(0);
			expect(slice.textColumns.length).toBeGreaterThan(0);
			expect(slice.referenceRule.length).toBeGreaterThan(0);
		}
	});

	test("every slice stays inside the supported language scope", () => {
		for (const slice of readBenchSlices()) {
			expect(["zh", "en", "mixed"]).toContain(slice.language);
			expect(["standard", "product", "smoke"]).toContain(slice.layer);
		}
	});

	test("slice ids are unique", () => {
		const ids = readBenchSlices().map((slice) => slice.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
