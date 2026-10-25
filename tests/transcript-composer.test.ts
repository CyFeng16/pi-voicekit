import { describe, expect, test } from "bun:test";
import { createComposer } from "../extensions/voice/transcript-composer";
import { joinTranscriptParts } from "../extensions/voice/transcript-join";

/**
 * The composer holds the preview transcript: `commit` events are immutable and append,
 * `partial` events replace only the live tail. What it renders must be exactly what
 * `joinTranscriptParts` produces for the same parts, because the panel, the editor sink and
 * the unconfirmed fallback all compare against that single stitching rule.
 */
describe("createComposer — commits and the live tail", () => {
	test("commits accumulate and a partial replaces only the tail", () => {
		const c = createComposer();
		c.applyCommit(0, "你好");
		c.applyPartial(1, 1, "世界");
		expect(c.text).toBe(joinTranscriptParts(["你好", "世界"]));
		c.applyPartial(1, 2, "世界啊");
		expect(c.text).toBe(joinTranscriptParts(["你好", "世界啊"]));
		expect(c.committedChars).toBe("你好".length);
	});

	test("the committed prefix survives every revision of the tail", () => {
		const c = createComposer();
		c.applyCommit(0, "第一段");
		c.applyCommit(1, "第二段");
		const committed = c.text;
		for (let revision = 1; revision <= 5; revision++) {
			c.applyPartial(2, revision, "第三段".slice(0, revision % 3));
			expect(c.text.startsWith(committed)).toBe(true);
		}
	});

	test("a partial is joined onto the commits with the shared boundary rule", () => {
		const c = createComposer();
		c.applyCommit(0, "hello");
		c.applyPartial(1, 1, "world");
		expect(c.text).toBe(joinTranscriptParts(["hello", "world"]));
		expect(c.text).toBe("hello world");
	});

	test("commits keep segment order even when they arrive out of order", () => {
		const c = createComposer();
		c.applyCommit(2, "丙");
		c.applyCommit(0, "甲");
		c.applyCommit(1, "乙");
		expect(c.text).toBe(joinTranscriptParts(["甲", "乙", "丙"]));
	});

	test("an empty composer renders an empty transcript", () => {
		const c = createComposer();
		expect(c.text).toBe("");
		expect(c.committedChars).toBe(0);
	});
});

describe("createComposer — staleness", () => {
	test("stale revisions are dropped", () => {
		const c = createComposer();
		c.applyPartial(1, 1, "初稿");
		c.applyPartial(1, 2, "二稿");
		c.applyPartial(1, 1, "初稿");
		expect(c.text).toBe(joinTranscriptParts(["二稿"]));
	});

	test("a repeated revision is dropped, including the same text", () => {
		const c = createComposer();
		c.applyPartial(0, 3, "甲");
		c.applyPartial(0, 3, "乙");
		expect(c.text).toBe(joinTranscriptParts(["甲"]));
	});

	test("a partial never resurrects a tail that a commit already replaced", () => {
		const c = createComposer();
		c.applyPartial(0, 4, "你好世");
		c.applyCommit(0, "你好世界");
		c.applyPartial(0, 5, "你好世");
		expect(c.text).toBe(joinTranscriptParts(["你好世界"]));
		expect(c.committedChars).toBe("你好世界".length);
	});

	test("a partial for an earlier, already committed segment is dropped", () => {
		const c = createComposer();
		c.applyCommit(0, "甲");
		c.applyCommit(1, "乙");
		c.applyPartial(0, 9, "甲甲");
		expect(c.text).toBe(joinTranscriptParts(["甲", "乙"]));
	});

	test("a repeated commit for the same segment does not duplicate text", () => {
		const c = createComposer();
		c.applyCommit(0, "你好");
		c.applyCommit(0, "你好");
		expect(c.text).toBe(joinTranscriptParts(["你好"]));
		expect(c.committedChars).toBe("你好".length);
	});

	test("a repeated commit for the same segment does not rewrite committed text", () => {
		const c = createComposer();
		c.applyCommit(0, "你好");
		c.applyCommit(0, "你好啊");
		expect(c.text).toBe(joinTranscriptParts(["你好"]));
	});

	test("a commit that lands after its own partial keeps only the committed text", () => {
		const c = createComposer();
		c.applyPartial(0, 1, "世界");
		c.applyCommit(0, "世界啊");
		expect(c.text).toBe(joinTranscriptParts(["世界啊"]));
	});

	test("the revision high-water mark resets at a new segment", () => {
		const c = createComposer();
		c.applyPartial(0, 7, "甲");
		c.applyPartial(1, 1, "乙");
		expect(c.text).toBe(joinTranscriptParts(["乙"]));
	});
});

describe("createComposer — committedChars and clear", () => {
	test("committedChars counts only commits, separator included", () => {
		const c = createComposer();
		c.applyCommit(0, "hello");
		c.applyCommit(1, "world");
		c.applyPartial(2, 1, "again");
		expect(c.committedChars).toBe(joinTranscriptParts(["hello", "world"]).length);
		expect(c.committedChars).toBe("hello world".length);
	});

	test("committedChars ignores empty commits", () => {
		const c = createComposer();
		c.applyCommit(0, "");
		c.applyCommit(1, "  ");
		expect(c.committedChars).toBe(0);
		expect(c.text).toBe("");
	});

	test("clear drops commits, the tail and the high-water marks", () => {
		const c = createComposer();
		c.applyCommit(0, "甲");
		c.applyPartial(1, 9, "乙");
		c.clear();
		expect(c.text).toBe("");
		expect(c.committedChars).toBe(0);
		c.applyCommit(0, "甲");
		c.applyPartial(1, 1, "乙");
		expect(c.text).toBe(joinTranscriptParts(["甲", "乙"]));
	});
});
