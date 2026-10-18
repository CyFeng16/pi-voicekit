import { describe, expect, test } from "bun:test";
import { cleanTranscript } from "../extensions/voice/transcript-cleanup";
import { punctuationGate } from "../extensions/voice/punctuation";

const ON = { fillers: true, numerals: true };

describe("cleanTranscript — filler particles", () => {
	test("removes a particle wherever it sits", () => {
		expect(cleanTranscript("呃我觉得可以", ON).text).toBe("我觉得可以");
		expect(cleanTranscript("我觉得呃就是这样", ON).text).toBe("我觉得就是这样");
		expect(cleanTranscript("这样的话嗯我们就开始", ON).text).toBe("这样的话我们就开始");
	});

	test("collapses a stuttered run", () => {
		expect(cleanTranscript("呃呃呃我不知道", ON).text).toBe("我不知道");
		expect(cleanTranscript("嗯嗯，对", ON).text).toBe("对");
	});

	test("collapses only the space a removal exposed", () => {
		expect(cleanTranscript("我希望 嗯 先看一下", ON).text).toBe("我希望 先看一下");
		expect(cleanTranscript("我希望  嗯  先", ON).text).toBe("我希望 先");
		expect(cleanTranscript("a  嗯  b", ON).text).toBe("a b");
		expect(cleanTranscript("a  b", ON).text).toBe("a  b");
	});

	test("keeps the dictation when nothing but fillers was said", () => {
		expect(cleanTranscript("嗯", ON).text).toBe("嗯");
		expect(cleanTranscript("呃呃", ON).text).toBe("呃呃");
	});

	test("removes nothing outside the two-character vocabulary", () => {
		expect(cleanTranscript("这个逻辑没问题", ON).text).toBe("这个逻辑没问题");
		expect(cleanTranscript("啊，那个就是这样哦", ON).text).toBe("啊，那个就是这样哦");
	});
});
