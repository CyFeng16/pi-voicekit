import { describe, expect, test } from "bun:test";
import { joinTranscriptParts } from "../extensions/voice/transcript-join";

/**
 * The stitching rule from docs/superpowers/specs/2026-09-26-polish-pipeline-design.md §4:
 * no separator when both sides of a boundary end/begin with a CJK character, a single
 * space otherwise. The shipped code joined every segment with a space, which is why a
 * dictated Chinese sentence came back as "是 什么时候" whenever the VAD cut at a pause.
 */
describe("joinTranscriptParts", () => {
	test("two Chinese segments meet with no separator", () => {
		expect(joinTranscriptParts(["这并不是告别", "钙钾等元素属于金属"])).toBe("这并不是告别钙钾等元素属于金属");
	});

	test("a Chinese segment ending with CJK punctuation meets the next one with no separator", () => {
		expect(joinTranscriptParts(["第一段。", "第二段"])).toBe("第一段。第二段");
	});

	test("supplementary-plane Han counts as CJK on both sides of the boundary", () => {
		expect(joinTranscriptParts(["甲\u{20000}", "\u{20000}乙"])).toBe("甲\u{20000}\u{20000}乙");
	});

	test("an ellipsis shared by English text is not treated as CJK punctuation", () => {
		expect(joinTranscriptParts(["wait…", "…really"])).toBe("wait… …really");
	});

	test("a space already inside a part is left alone", () => {
		expect(joinTranscriptParts(["a b", "c d"])).toBe("a b c d");
		expect(joinTranscriptParts(["甲 乙", "丙"])).toBe("甲 乙丙");
	});

	test("Latin segments keep the word spacing", () => {
		expect(joinTranscriptParts(["hello", "world"])).toBe("hello world");
	});

	test("a Chinese/Latin boundary keeps exactly one space", () => {
		expect(joinTranscriptParts(["测试通过", "cpu 很高"])).toBe("测试通过 cpu 很高");
		expect(joinTranscriptParts(["跑完 k8s", "集群很稳"])).toBe("跑完 k8s 集群很稳");
	});

	test("a Latin segment followed by CJK punctuation still gets one space", () => {
		expect(joinTranscriptParts(["see you", "。继续"])).toBe("see you 。继续");
	});

	test("empty and whitespace-only parts are dropped, not joined", () => {
		expect(joinTranscriptParts(["甲", "", "  ", "乙"])).toBe("甲乙");
		expect(joinTranscriptParts([])).toBe("");
		expect(joinTranscriptParts(["", ""])).toBe("");
	});

	test("each part is trimmed before the boundary is inspected", () => {
		expect(joinTranscriptParts([" 甲 ", " 乙 "])).toBe("甲乙");
		expect(joinTranscriptParts([" 甲 ", " cpu "])).toBe("甲 cpu");
	});

	test("a single part is returned as it stands", () => {
		expect(joinTranscriptParts(["单段听写"])).toBe("单段听写");
	});
});
