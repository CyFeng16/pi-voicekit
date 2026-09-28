import { describe, expect, test } from "bun:test";
import { hasCjk, punctuationDensity, PUNCTUATION_DENSITY_MAX, shouldPunctuate } from "../extensions/voice/punctuation";

// A 100-code-point sentence carrying exactly one stray mark — density 0.01, far below the
// threshold, so the stray mark must not block the step (spec §4.3, revision 5).
const ONE_STRAY_MARK_IN_100 = "我".repeat(99) + "。";

// Exactly 1 mark per 20 code points — the boundary. Below punctuates, at or above skips.
const AT_ONE_MARK_PER_20 = "。" + "你".repeat(19);

// 2 marks in 20 code points — above the boundary.
const ABOVE_ONE_MARK_PER_20 = "。。" + "你".repeat(18);

const CJK_UNPUNCTUATED = "今天天气很好我们一起去公园散步吧";
const PURE_ENGLISH = "hello world how are you doing today";
const IDENTIFIERS_AND_PATHS = "/usr/local/bin/run --flag=1 base_url Node.js 42";
const EMPTY = "";
const WHITESPACE_ONLY = "   \n\t  ";

describe("hasCjk", () => {
	test("is true for Han text", () => {
		expect(hasCjk("你好")).toBe(true);
	});

	test("is true for Han mixed with Latin", () => {
		expect(hasCjk("hello 世界")).toBe(true);
	});

	test("is false for Latin, digits and paths", () => {
		expect(hasCjk(PURE_ENGLISH)).toBe(false);
		expect(hasCjk("12345")).toBe(false);
		expect(hasCjk(IDENTIFIERS_AND_PATHS)).toBe(false);
		expect(hasCjk(EMPTY)).toBe(false);
	});

	test("is false for CJK punctuation alone — the model gates on ideographs, not marks", () => {
		expect(hasCjk("、。！？；：")).toBe(false);
	});
});

describe("punctuationDensity", () => {
	test("is zero for empty input", () => {
		expect(punctuationDensity("")).toBe(0);
	});

	test("returns marks per code point", () => {
		expect(punctuationDensity("。" + "你".repeat(19))).toBe(0.05);
		expect(punctuationDensity("。。" + "你".repeat(18))).toBeCloseTo(0.1, 10);
	});

	test("counts full-width marks the same as their NFKC ASCII forms", () => {
		expect(punctuationDensity("你好！")).toBe(punctuationDensity("你好!"));
		expect(punctuationDensity("你好，世界")).toBe(punctuationDensity("你好,世界"));
	});

	test("takes both the numerator and the denominator from the NFKC-normalized string", () => {
		// U+337F (㍿) NFKC-expands to four code points, so the normalized denominator is 5, not 2.
		// Mixing a normalized numerator with a raw denominator would report 1/2 instead of 1/5.
		expect(punctuationDensity("。㍿")).toBeCloseTo(0.2, 10);
	});
});

describe("shouldPunctuate — the text rule of spec §4.3", () => {
	test("the threshold is one exported constant calibrated at 1 mark per 20 characters", () => {
		expect(PUNCTUATION_DENSITY_MAX).toBe(0.05);
	});

	test("punctuates unpunctuated CJK", () => {
		expect(shouldPunctuate(CJK_UNPUNCTUATED, true)).toBe(true);
	});

	test("one stray mark in a 100-character sentence never blocks the step", () => {
		expect(shouldPunctuate(ONE_STRAY_MARK_IN_100, true)).toBe(true);
	});

	test("skips CJK at exactly 1 mark per 20 characters", () => {
		expect(shouldPunctuate(AT_ONE_MARK_PER_20, true)).toBe(false);
	});

	test("skips CJK above 1 mark per 20 characters", () => {
		expect(shouldPunctuate(ABOVE_ONE_MARK_PER_20, true)).toBe(false);
	});

	test("skips pure English", () => {
		expect(shouldPunctuate(PURE_ENGLISH, true)).toBe(false);
	});

	test("skips digits, paths and identifiers alone", () => {
		expect(shouldPunctuate(IDENTIFIERS_AND_PATHS, true)).toBe(false);
	});

	test("skips empty and whitespace-only input", () => {
		expect(shouldPunctuate(EMPTY, true)).toBe(false);
		expect(shouldPunctuate(WHITESPACE_ONLY, true)).toBe(false);
	});

	test("the switch wins: enabled false is false for every input", () => {
		for (const input of [
			CJK_UNPUNCTUATED,
			ONE_STRAY_MARK_IN_100,
			AT_ONE_MARK_PER_20,
			ABOVE_ONE_MARK_PER_20,
			PURE_ENGLISH,
			IDENTIFIERS_AND_PATHS,
			EMPTY,
			WHITESPACE_ONLY,
		]) {
			expect(shouldPunctuate(input, false)).toBe(false);
		}
	});

	test("the decision is a pure function of the text and the switch", () => {
		// No recogniser, model id or catalogue takes part — the signature carries exactly
		// (text, enabled) and the same text always yields the same answer (invariant 5).
		expect(shouldPunctuate.length).toBe(2);
		expect(shouldPunctuate(CJK_UNPUNCTUATED, true)).toBe(shouldPunctuate(CJK_UNPUNCTUATED, true));
	});
});
