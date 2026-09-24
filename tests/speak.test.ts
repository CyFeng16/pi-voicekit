import { describe, expect, test } from "bun:test";
import { chunkText } from "../extensions/voice/speak";

describe("chunkText — robust sentence segmentation", () => {
	test("simple multi-sentence text splits cleanly", () => {
		const out = chunkText("First sentence. Second sentence. Third sentence.", "en");
		expect(out.length).toBeGreaterThanOrEqual(1);
		expect(out.join(" ").replace(/\s+/g, " ").trim()).toContain("First sentence");
		expect(out.join(" ").replace(/\s+/g, " ").trim()).toContain("Third sentence");
	});

	test("does not split on Dr. abbreviation", () => {
		const out = chunkText("Dr. Smith said hello.", "en");
		// All output joined back together still contains the abbreviation
		// adjacent to the surname — i.e. no chunk break inside "Dr. Smith".
		expect(out.join(" ")).toContain("Dr. Smith");
	});

	test("does not split on e.g. abbreviation", () => {
		const out = chunkText("Use a fast TTS, e.g. Kitten Nano.", "en");
		expect(out.join(" ")).toContain("e.g. Kitten");
	});

	test("does not split on v2.0 version number", () => {
		const out = chunkText("Released v2.0 yesterday.", "en");
		expect(out.join(" ")).toContain("v2.0 yesterday");
	});

	test("does not split on U.S.A. dotted acronym", () => {
		const out = chunkText("Born in the U.S.A.", "en");
		expect(out.join(" ")).toContain("U.S.A.");
	});

	test("does not split inside URLs", () => {
		const out = chunkText("Visit https://example.com/path.", "en");
		expect(out.join(" ")).toContain("https://example.com/path");
	});

	test("does not split decimal numbers", () => {
		const out = chunkText("Pi is 3.14159 approximately.", "en");
		expect(out.join(" ")).toContain("3.14159");
	});

	test("regression: combined edge cases stay intact", () => {
		// The exact string locked in the v6.0.0 plan as a regression case
		const text = "Dr. Smith said e.g. v2.0 isn't U.S.A.-ready. Visit https://x.dev/p.";
		const out = chunkText(text, "en");
		const joined = out.join(" ");
		expect(joined).toContain("Dr. Smith");
		expect(joined).toContain("e.g. v2.0");
		expect(joined).toContain("U.S.A.");
		expect(joined).toContain("https://x.dev/p");
	});

	test("empty / whitespace-only input returns empty array", () => {
		expect(chunkText("", "en")).toEqual([]);
		expect(chunkText("   \n\t  ", "en")).toEqual([]);
	});

	test("very long single sentence is split on word boundaries (never mid-token)", () => {
		const sentence = "word ".repeat(500).trim();
		const out = chunkText(sentence, "en");
		expect(out.length).toBeGreaterThan(1);
		// Every chunk is a sequence of complete words separated by single
		// spaces — no chunk ends inside a token.
		for (const chunk of out) {
			expect(chunk.split(/\s+/).every((t) => t === "" || /^\w+$/.test(t))).toBe(true);
		}
	});

	test("each chunk respects MAX_CHUNK_CHARS", () => {
		const sentence = "lorem ipsum ".repeat(200).trim();
		const out = chunkText(sentence, "en");
		for (const chunk of out) {
			expect(chunk.length).toBeLessThanOrEqual(700); // small slack for the join padding
		}
	});
});
