/**
 * Tests for the synthetic ASR-error injector.
 *
 * The injector exists so the post-processing numbers can be produced without a
 * human: it degrades a clean sentence the way a recogniser would, which gives a
 * corpus with known ground truth. Two properties matter more than the error
 * realism, because the numbers are compared across runs: the output must be
 * deterministic for a given seed, and it must never invent wording that is not
 * in the injector's own tables - otherwise a "gain" could come from the injector
 * rather than from the pass.
 */
import { describe, expect, test } from "bun:test";
import {
	buildSyntheticCorpus,
	injectAsrErrors,
	KNOWN_FILLERS,
	KNOWN_SPLITS,
	renderReadingScript,
} from "../scripts/polish-eval/inject";
import type { CorpusSeed } from "../scripts/polish-eval/inject";

const SEEDS: CorpusSeed[] = [
	{ id: "s1", category: "punctuation", text: "把端口设成 8080。然后重启服务。" },
	{ id: "s2", category: "zh-en-switch", text: "先看 axios 的 timeout，再看 redis 的连接数。" },
	{ id: "s3", category: "fillers", text: "嗯那个我们把那个字段改一下。" },
];

describe("injectAsrErrors", () => {
	test("is deterministic for the same seed", () => {
		const first = injectAsrErrors("先看 axios 的 timeout 配置。", { seed: 7 });
		const second = injectAsrErrors("先看 axios 的 timeout 配置。", { seed: 7 });
		expect(second).toEqual(first);
	});

	test("differs across seeds for at least one kind of error", () => {
		const raws = new Set([1, 2, 3, 4, 5, 6].map((seed) => injectAsrErrors("看 nginx 的日志。", { seed }).raw));
		expect(raws.size).toBeGreaterThan(1);
	});

	test("removes sentence punctuation", () => {
		const { raw, applied } = injectAsrErrors("把端口设成 8080。然后重启服务。", {
			seed: 1,
			kinds: ["punctuation"],
		});
		expect(applied).toEqual(["punctuation"]);
		expect(raw).not.toContain("。");
		expect(raw).not.toContain("，");
	});

	test("splits a technical term into the recogniser's phonetic guess", () => {
		const { raw } = injectAsrErrors("先看 axios 的 timeout。", { seed: 2, kinds: ["term-split"] });
		expect(KNOWN_SPLITS.some(([, wrong]) => raw.includes(wrong))).toBe(true);
	});

	test("only ever inserts fillers from its own table", () => {
		const { raw } = injectAsrErrors("看日志。", { seed: 3, kinds: ["filler"] });
		const inserted = raw.split(/\s+/).filter((token) => token.length > 0);
		for (const filler of KNOWN_FILLERS) {
			if (!raw.includes(filler)) continue;
			expect(inserted.length).toBeGreaterThan(0);
		}
		// Everything added must be a known filler: the clean wording is still there.
		// Everything added must be a known filler: the clean wording is still there once
		// the table phrases are removed, before whitespace is collapsed (one of them has a space).
		const withoutFillers = KNOWN_FILLERS.reduce((acc, filler) => acc.split(filler).join(""), raw);
		const wording = withoutFillers.replace(/[。！？，]/g, "").replace(/\s+/g, "");
		expect(wording).toBe("看日志");
	});

	test("never introduces wording that is not in the clean text or its tables", () => {
		const clean = "把 timeout 设成 30 秒。";
		for (let seed = 1; seed <= 20; seed += 1) {
			const { raw } = injectAsrErrors(clean, { seed });
			const allowed = [clean, ...KNOWN_SPLITS.map(([, wrong]) => wrong), ...KNOWN_FILLERS];
			// Remove the table phrases first: whitespace collapsing would break the
			// multi-word ones before they could be matched.
			const withoutTables = allowed.reduce((acc, phrase) => acc.split(phrase).join(""), raw);
			const stripped = withoutTables.replace(/[。，、！？；：（）]/g, "").replace(/\s+/g, "");
			// Whatever is left must be a mangling of the clean text, never new wording:
			// compare its characters against the clean characters.
			for (const char of stripped) {
				if (/\s/.test(char)) continue;
				expect(clean.includes(char)).toBe(true);
			}
		}
	});

	test("reports which kinds it applied and applies at least one by default", () => {
		const { applied } = injectAsrErrors("先看 axios 的 timeout 配置。", { seed: 5 });
		expect(applied.length).toBeGreaterThan(0);
	});

	test("leaves a sentence without punctuation untouched when no kind applies", () => {
		const { raw, applied } = injectAsrErrors("看日志", { seed: 9, kinds: [] });
		expect(raw).toBe("看日志");
		expect(applied).toEqual([]);
	});
});

describe("buildSyntheticCorpus", () => {
	test("produces one entry per seed with the seed as ground truth", () => {
		const corpus = buildSyntheticCorpus(SEEDS, { seed: 11 });
		expect(corpus.length).toBe(SEEDS.length);
		for (const [index, entry] of corpus.entries()) {
			expect(entry.id).toBe(SEEDS[index]!.id);
			expect(entry.category).toBe(SEEDS[index]!.category);
			expect(entry.groundTruth).toBe(SEEDS[index]!.text);
			expect(entry.backend).toBe("synthetic");
			expect(entry.raw.length).toBeGreaterThan(0);
		}
	});

	test("is deterministic for a given base seed", () => {
		expect(buildSyntheticCorpus(SEEDS, { seed: 4 })).toEqual(buildSyntheticCorpus(SEEDS, { seed: 4 }));
	});

	test("varies the per-entry raw text with the base seed", () => {
		const first = buildSyntheticCorpus(SEEDS, { seed: 1 }).map((entry) => entry.raw);
		const second = buildSyntheticCorpus(SEEDS, { seed: 2 }).map((entry) => entry.raw);
		expect(second).not.toEqual(first);
	});

	test("keeps the raw text different from the ground truth so a gain is measurable", () => {
		const corpus = buildSyntheticCorpus(SEEDS, { seed: 21 });
		for (const entry of corpus) expect(entry.raw).not.toBe(entry.groundTruth);
	});
});

describe("renderReadingScript", () => {
	test("lists every seed once, grouped by category, with its id", () => {
		const script = renderReadingScript(SEEDS);
		for (const seed of SEEDS) expect(script).toContain(seed.id);
		expect(script.match(/s1/g)?.length).toBe(1);
		expect(script).toContain("punctuation");
	});

	test("never prints the raw injected text, only the text to read aloud", () => {
		const script = renderReadingScript(SEEDS);
		// The script carries the clean text with its punctuation, not the degraded form.
		expect(script).toContain("把端口设成 8080。然后重启服务。");
		expect(script).not.toContain("把端口设成 8080然后重启服务");
	});
});
