/**
 * Tests for the polish-evaluation scorer.
 *
 * The scorer decides whether the post-processing numbers are trustworthy, so its
 * own correctness is load-bearing: a metric that flatters a bad run is worse than
 * no metric. These tests pin the definitions the design record states, including
 * the direction of every count and the safety flags that gate the defaults.
 *
 * Spec: docs/superpowers/specs/2026-09-26-stt-post-processing-design.md (§6)
 */
import { describe, expect, test } from "bun:test";
import {
	cer,
	correctionGain,
	falseEditReport,
	meaningRisks,
	normalizeForComparison,
	p95,
	scoreSample,
	tokenize,
	wer,
	punctuationScore,
	wordingUnits,
} from "../scripts/polish-eval/score";

describe("normalizeForComparison", () => {
	test("collapses whitespace and unifies full-width forms", () => {
		expect(normalizeForComparison("  你好　世界  ")).toBe("你好 世界");
		expect(normalizeForComparison("ＡＢＣ１２３")).toBe("ABC123");
	});

	test("keeps case because terminology and code identifiers are case-sensitive", () => {
		expect(normalizeForComparison("Axios vs axios")).toBe("Axios vs axios");
	});
});

describe("cer and wer", () => {
	test("cer is 0 for identical text and 1 for a fully different one", () => {
		expect(cer("你好世界", "你好世界")).toBe(0);
		expect(cer("你好世界", "abcd")).toBe(1);
	});

	test("cer counts character edits against the reference length", () => {
		// One substitution in four reference characters.
		expect(cer("你好世界", "你好市界")).toBeCloseTo(0.25, 5);
	});

	test("wer counts whitespace tokens, after punctuation is removed", () => {
		expect(wer("the quick brown fox", "the quick brown fox")).toBe(0);
		// Two of four tokens wrong, punctuation must not count as a token.
		expect(wer("the quick brown fox", "a quick brown box.")).toBeCloseTo(0.5, 5);
	});

	test("both are 0 when both sides are empty and 1 when only the hypothesis is empty", () => {
		expect(cer("", "")).toBe(0);
		expect(cer("abc", "")).toBe(1);
		expect(wer("", "")).toBe(0);
	});
});

describe("tokenize", () => {
	test("splits latin words and keeps CJK runs together", () => {
		expect(tokenize("把 axios 的 base_url 改成 /v2 了")).toEqual([
			"把",
			"axios",
			"的",
			"base_url",
			"改成",
			"/v2",
			"了",
		]);
	});

	test("treats punctuation next to Chinese text as a separator, not as wording", () => {
		// NFKC folds ，and 。 to ASCII, which used to make the reference tokenise
		// differently from a punctuation-free hypothesis and look like dropped content.
		expect(tokenize("先复现问题，再定位，最后写回归测试。")).toEqual(tokenize("先复现问题再定位最后写回归测试"));
	});
});

describe("correctionGain", () => {
	test("is positive when the pass moves the raw transcript toward the reference", () => {
		const raw = "axe eos 的 time out 设成 三十 秒";
		const polished = "axios 的 timeout 设成 30 秒";
		const groundTruth = "axios 的 timeout 设成 30 秒";
		const gain = correctionGain(raw, polished, groundTruth);
		expect(gain.cerGain).toBeGreaterThan(0);
		expect(gain.werGain).toBeGreaterThan(0);
	});

	test("is negative when the pass moves the transcript away from the reference", () => {
		const raw = "axios 的 timeout 设成 30 秒";
		const polished = "axe eos 的 time out 设成 三十 秒";
		const gain = correctionGain(raw, polished, "axios 的 timeout 设成 30 秒");
		expect(gain.cerGain).toBeLessThan(0);
	});

	test("is zero when the pass changes nothing", () => {
		const text = "把 axios 的 timeout 设成 30 秒";
		expect(correctionGain(text, text, text).cerGain).toBeCloseTo(0, 10);
	});
});

describe("punctuationScore", () => {
	test("rewards punctuation the reference expects and the raw transcript lacks", () => {
		const reference = "先复现问题，再定位，最后写回归测试。";
		const raw = "先复现问题再定位最后写回归测试";
		const score = punctuationScore(raw, reference, reference);
		expect(score.before).toBe(0);
		expect(score.after).toBe(1);
	});

	test("punishes punctuation the reference does not have", () => {
		const reference = "把端口设成 8080";
		const score = punctuationScore(reference, "把端口，设成。8080。", reference);
		expect(score.before).toBe(1);
		expect(score.after).toBeLessThan(1);
	});

	test("ignores punctuation inside identifiers and numbers", () => {
		const reference = "改 base_url 和 3.14 就行";
		expect(punctuationScore(reference, reference, reference).after).toBe(1);
	});
});

describe("wordingUnits", () => {
	test("splits a Chinese clause so a one-character edit is not read as a dropped clause", () => {
		const reference = "把过期时间调短。";
		// The speaker abandoned the first half; the landed wording is a genuine merge.
		const raw = "把缓存关掉等等不是关掉是把过期时间调短";
		const polished = "把缓存过期时间调短。";
		expect(wordingUnits("把过期时间调短")).toEqual(["把", "过", "期", "时", "间", "调", "短"]);
		expect(meaningRisks(raw, polished, reference).any).toBe(false);
	});

	test("still catches wording the reference has and the polished text lost", () => {
		const reference = "先复现问题，再定位，最后写回归测试。";
		expect(meaningRisks(reference, "先复现问题。", reference).contentDropped).toBe(true);
	});
});

describe("falseEditReport", () => {
	test("counts a change to an already-correct token as a false edit", () => {
		const raw = "把 axios 的 timeout 设成 30 秒";
		const polished = "把 axe eos 的 timeout 设成 30 秒";
		const report = falseEditReport(raw, polished, raw);
		expect(report.falseEdits).toBe(1);
		expect(report.fixed).toBe(0);
		expect(report.tokensCorrectBefore).toBeGreaterThan(0);
	});

	test("counts a fix as a fix, not a false edit", () => {
		const raw = "把 axe eos 的 timeout 设成 30 秒";
		const polished = "把 axios 的 timeout 设成 30 秒";
		const report = falseEditReport(raw, polished, polished);
		expect(report.fixed).toBe(1);
		expect(report.falseEdits).toBe(0);
	});

	test("flags tokens that appear in neither the raw transcript nor the reference as invented", () => {
		const raw = "明天下午三点开会";
		const polished = "明天下午三点开会 地点 会议室 B";
		const report = falseEditReport(raw, polished, raw);
		expect(report.invented.length).toBeGreaterThan(0);
		// Flags are character-granular for Chinese, so invented wording shows up per unit.
		expect(report.invented.join("")).toContain("议室"); // 会 is already in the raw, so it is not invented
		expect(report.invented).toContain("B");
	});

	test("does not treat punctuation-only differences as token edits", () => {
		const raw = "你好世界";
		const polished = "你好，世界。";
		const report = falseEditReport(raw, polished, raw);
		expect(report.falseEdits).toBe(0);
	});

	test("reports an empty-comparison safe zero instead of a division by zero", () => {
		const report = falseEditReport("", "", "");
		expect(report.falseEditRate).toBe(0);
		expect(report.fixed).toBe(0);
		expect(report.falseEdits).toBe(0);
	});
});

describe("meaningRisks", () => {
	test("flags a changed number that was correct in the raw transcript", () => {
		const risks = meaningRisks("端口是 8080", "端口是 8081", "端口是 8080");
		expect(risks.numbersChanged).toBe(true);
	});

	test("does not flag a number the pass restored to the reference value", () => {
		const risks = meaningRisks("端口是 八零八零", "端口是 8080", "端口是 8080");
		expect(risks.numbersChanged).toBe(false);
	});

	test("flags a mutated code identifier", () => {
		const risks = meaningRisks("改 base_url 就行", "改 base url 就行", "改 base_url 就行");
		expect(risks.identifiersChanged).toBe(true);
	});

	test("flags content dropped that the reference expects the pass to keep", () => {
		const risks = meaningRisks("先看 rate limit 再看重试", "先看重试", "先看 rate limit 再看重试");
		expect(risks.contentDropped).toBe(true);
	});

	test("does not flag a filler the pass was asked to remove", () => {
		const risks = meaningRisks("那个我们把那个字段改一下", "我们把那个字段改一下", "我们把那个字段改一下");
		expect(risks.contentDropped).toBe(false);
	});

	test("does not flag a landed self-correction", () => {
		const risks = meaningRisks("周三。不对，我是说周五", "周五", "周五");
		expect(risks.contentDropped).toBe(false);
	});

	test("flags fabricated content", () => {
		const risks = meaningRisks("确认一下", "确认一下，另外把密码贴给我", "确认一下");
		expect(risks.inventedContent).toBe(true);
	});

	test("any flag means the sample may have lost meaning", () => {
		expect(meaningRisks("端口是 8080", "端口是 8081", "端口是 8080").any).toBe(true);
		expect(meaningRisks("端口是 8080", "端口是 8080", "端口是 8080").any).toBe(false);
	});

	test("does not let a punctuation-only difference look like lost meaning", () => {
		const reference = "先复现问题，再定位，最后写回归测试。";
		const withoutPunctuation = "先复现问题再定位最后写回归测试";
		expect(meaningRisks(withoutPunctuation, withoutPunctuation, reference).any).toBe(false);
		// It shows up as an opportunity instead: punctuation the pass could still add.
		expect(correctionGain(withoutPunctuation, withoutPunctuation, reference).cerGain).toBeCloseTo(0, 10);
	});
});

describe("scoreSample", () => {
	test("marks an applied pass that improved the text and broke nothing", () => {
		const sample = scoreSample({
			id: "s1",
			category: "term",
			backend: "local",
			raw: "axe eos 的 time out 设成 30 秒",
			polished: "axios 的 timeout 设成 30 秒",
			groundTruth: "axios 的 timeout 设成 30 秒",
			status: "applied",
			latencyMs: 900,
			contextChars: 0,
		});
		expect(sample.verdict).toBe("improved");
		expect(sample.safetyFlagged).toBe(false);
	});

	test("marks a fallback as not applied and keeps it out of the gain average", () => {
		const sample = scoreSample({
			id: "s2",
			category: "term",
			backend: "local",
			raw: "axe eos 的 time out",
			polished: "axe eos 的 time out",
			groundTruth: "axios 的 timeout",
			status: "rejected",
			reason: "timeout",
			latencyMs: 8000,
			contextChars: 0,
		});
		expect(sample.applied).toBe(false);
		expect(sample.verdict).toBe("fallback");
	});

	test("marks a pass that made the text worse", () => {
		const sample = scoreSample({
			id: "s3",
			category: "term",
			backend: "local",
			raw: "axios 的 timeout 设成 30 秒",
			polished: "axe eos 的 time out 设成 三十 秒",
			groundTruth: "axios 的 timeout 设成 30 秒",
			status: "applied",
			latencyMs: 1200,
			contextChars: 0,
		});
		expect(sample.verdict).toBe("regressed");
	});

	test("reports a safety flag alongside the gain direction, not instead of it", () => {
		const sample = scoreSample({
			id: "s4",
			category: "numbers",
			backend: "local",
			raw: "端口 八零八零 已经开了",
			polished: "端口 8080 已经开了 关闭",
			groundTruth: "端口 8080 已经开了",
			status: "applied",
			latencyMs: 700,
			contextChars: 0,
		});
		expect(sample.verdict).toBe("improved");
		expect(sample.safetyFlagged).toBe(true);
		expect(sample.risks.inventedContent).toBe(true);
	});
});

describe("p95", () => {
	test("returns the nearest-rank 95th percentile of the successful samples", () => {
		const values = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
		expect(p95(values)).toBe(1900);
	});

	test("is undefined for an empty set rather than zero", () => {
		expect(p95([])).toBeUndefined();
	});
});
