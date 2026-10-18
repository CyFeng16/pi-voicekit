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

describe("cleanTranscript — numerals inside identifiers", () => {
	test("restores a digit between two one-character Latin tokens", () => {
		expect(cleanTranscript("k 八 s", ON).text).toBe("k8s");
		expect(cleanTranscript("t 一 k 等于二", ON).text).toBe("t1k 等于二");
	});

	test("restores a digit after a Latin token of at most four characters", () => {
		expect(cleanTranscript("bf 十六", ON).text).toBe("bf16");
		expect(cleanTranscript("h 二百 部署", ON).text).toBe("h200 部署");
		expect(cleanTranscript("在 a 零二上复刻", ON).text).toBe("在 a02上复刻");
		expect(cleanTranscript("v 四点一", ON).text).toBe("v4.1");
	});

	test("restores a digit before a short Latin token", () => {
		expect(cleanTranscript("八 d 指间", ON).text).toBe("8d 指间");
		expect(cleanTranscript("四 p 十二 d", ON).text).toBe("4p12d");
	});

	test("restores a bare version with two decimal points", () => {
		expect(cleanTranscript("现在最新的 零点九九点一", ON).text).toBe("现在最新的 0.99.1");
	});

	test("refuses a numeral it cannot read", () => {
		expect(cleanTranscript("w 三点十", ON).text).toBe("w 三点十");
	});

	test("leaves Chinese prose, long Latin words and existing digits alone", () => {
		expect(cleanTranscript("统一口径", ON).text).toBe("统一口径");
		expect(cleanTranscript("四卡 h200 部署", ON).text).toBe("四卡 h200 部署");
		expect(cleanTranscript("二零一一年八月完工", ON).text).toBe("二零一一年八月完工");
		expect(cleanTranscript("先 三 个批次", ON).text).toBe("先 三 个批次");
		expect(cleanTranscript("用 kubernetes 八 个节点", ON).text).toBe("用 kubernetes 八 个节点");
	});

	test("an English sentence keeps its numeral, as the spec accepts", () => {
		expect(cleanTranscript("see 八 things", ON).text).toBe("see8 things");
	});
});

describe("cleanTranscript — switches and invariants", () => {
	test("each switch only touches its own class", () => {
		expect(cleanTranscript("呃 k 八 s", { fillers: true, numerals: false }).text).toBe("k 八 s");
		expect(cleanTranscript("呃 k 八 s", { fillers: false, numerals: true }).text).toBe("呃 k8s");
	});

	test("both switches off leaves the text alone and reports off", () => {
		const result = cleanTranscript("呃 k 八 s", { fillers: false, numerals: false });
		expect(result.text).toBe("呃 k 八 s");
		expect(result.status).toBe("off");
	});

	test("applying the step to its own output changes nothing", () => {
		const once = cleanTranscript("呃 在 a 零二上复刻 bf 十六", ON);
		expect(once.text).toBe("在 a02上复刻 bf16");
		expect(cleanTranscript(once.text, ON).text).toBe(once.text);
	});

	test("cleaning changes the punctuation gate a filler-heavy transcript used to pass", () => {
		const raw = `${"呃".repeat(30)}好的。`;
		expect(punctuationGate(raw, true)).toBe("needed");
		const cleaned = cleanTranscript(raw, ON).text;
		expect(cleaned).toBe("好的。");
		expect(punctuationGate(cleaned, true)).toBe("dense");
	});
});
