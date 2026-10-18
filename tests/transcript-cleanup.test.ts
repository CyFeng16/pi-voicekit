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

	test.each([
		["bf 十六 and fp 十六", "bf16 and fp16"],
		["use 八 GPUs", "use8 GPUs"],
	])("keeps the space before a multi-character right token: %s", (input, expected) => {
		expect(cleanTranscript(input, ON).text).toBe(expected);
		expect(cleanTranscript(expected, ON).text).toBe(expected);
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

	test.each([
		["现在最新的 零点九九点一", "现在最新的 0.99.1"],
		["版本\t零点九九点一", "版本\t0.99.1"],
		["零点九九点一\n", "0.99.1\n"],
	])("restores a bare version bounded by whitespace: %s", (input, expected) => {
		expect(cleanTranscript(input, ON).text).toBe(expected);
		expect(cleanTranscript(expected, ON).text).toBe(expected);
	});

	test.each(["k\t八 s", "八\ns", "a  八  b", "版本零点九九点一", "零点九九点一。"])(
		"does not loosen identifier or bare-version boundaries: %s",
		(input) => {
			expect(cleanTranscript(input, ON).text).toBe(input);
		}
	);

	test.each(["w 三点十", "h 一二百", "h 百百", "h 一百二三", "h 一百二千", "h 零百"])(
		"refuses a numeral it cannot read: %s",
		(input) => {
			expect(cleanTranscript(input, ON).text).toBe(input);
		}
	);

	test.each(["y 一万五点九", "h 一百二点五"])("refuses shorthand before a point: %s", (input) => {
		expect(cleanTranscript(input, ON).text).toBe(input);
	});

	test.each([
		["h 二十万", "h200000"],
		["h 十万", "h100000"],
		["h 一百万", "h1000000"],
		["h 十二万", "h120000"],
		["h 一百二十万", "h1200000"],
		["h 三千万", "h30000000"],
		["h 一千二百万", "h12000000"],
		["h 十二万三千", "h123000"],
		["h 二十万零五", "h200005"],
	])("reads a group of four places closed by `万`: %s", (input, expected) => {
		// `万` starts a new group, so `十 → 万` is not an increasing unit; the four-place group
		// before it still has to fall, which is what keeps `h 一百二千` refused by the test above.
		expect(cleanTranscript(input, ON).text).toBe(expected);
	});

	test("refuses a trailing shorthand rather than reading it positionally", () => {
		// `一百二` is 120 and `一万五` is 15000; a place-by-place reading would write 102 and 10005.
		expect(cleanTranscript("h 一百二", ON).text).toBe("h 一百二");
		expect(cleanTranscript("h 一万五", ON).text).toBe("h 一万五");
		// The exact readings around the same units still convert, so the refusal stays narrow.
		expect(cleanTranscript("bf 十六", ON).text).toBe("bf16");
		expect(cleanTranscript("h 十五", ON).text).toBe("h15");
		expect(cleanTranscript("h 一百零二", ON).text).toBe("h102");
		expect(cleanTranscript("h 一百二十", ON).text).toBe("h120");
		expect(cleanTranscript("h 一千零一", ON).text).toBe("h1001");
		expect(cleanTranscript("h 一万二千", ON).text).toBe("h12000");
		expect(cleanTranscript("h 一千二百", ON).text).toBe("h1200");
	});

	test("reports the conversion it applied", () => {
		const result = cleanTranscript("k 八 s", ON);
		expect(result.status).toBe("applied");
		expect(result.numeralsConverted).toBe(1);
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

	test("fillers are removed before the numeral rule runs", () => {
		// The other order would stop the numeral rule binding and leave `k 八 s` behind.
		expect(cleanTranscript("k 呃 八 s", ON).text).toBe("k8s");
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
