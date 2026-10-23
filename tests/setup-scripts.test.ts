import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("documentation", () => {
	const retiredIdentifiers = /deepgram|dpgr\.am/i;

	/**
	 * The privacy claim and the two exceptions that narrow it. Both are the user's own configuration
	 * rather than something the extension does: routing playback or capture to another host, and
	 * handing the transcript to Pi's model. They must sit in the same block as the claim — a reader
	 * who finds the claim without them believes nothing ever leaves the machine.
	 */
	const CLAIM_EN = "No audio is uploaded to a remote speech service.";
	const CLAIM_ZH = "没有任何音频被上传到远端语音服务。";

	/** The text from the claim to the next subsection heading after it: the block the claim owns. */
	function exceptionBlock(readme: string, section: string, claim: string): string {
		const sectionAt = readme.indexOf(section);
		expect(sectionAt).toBeGreaterThan(-1);
		const claimAt = readme.indexOf(claim, sectionAt);
		expect(claimAt).toBeGreaterThan(-1);
		return readme.slice(claimAt, readme.indexOf("###", claimAt));
	}

	test("README sells a local-only product", () => {
		const readme = read("README.md");
		expect(readme).not.toMatch(retiredIdentifiers);
		expect(readme).toContain("/voice-settings");
		expect(readme).toContain("/voice test");
		expect(readme).toContain(CLAIM_EN);
		expect(readme).toContain("active local model");
	});

	test("README names both exceptions to the claim where the claim is made", () => {
		const block = exceptionBlock(read("README.md"), "## Privacy", CLAIM_EN);
		expect(block).toContain("System audio routing");
		expect(block).toContain("PULSE_SERVER");
		expect(block).toContain("Auto-submit");
	});

	test("zh-CN README mirrors the local-only claim", () => {
		const readme = read("i18n/README.zh-CN.md");
		expect(readme).toContain(CLAIM_ZH);
		expect(readme).toContain("不传输遥测、分析或崩溃上报数据：没有任何崩溃上报器，也没有远程日志。");
		expect(readme).not.toMatch(retiredIdentifiers);
	});

	test("zh-CN README carries the same two exceptions", () => {
		const block = exceptionBlock(read("i18n/README.zh-CN.md"), "## 隐私", CLAIM_ZH);
		expect(block).toContain("系统音频路由");
		expect(block).toContain("PULSE_SERVER");
		expect(block).toContain("自动提交");
	});

	test("README documents audio fallback chain", () => {
		const readme = read("README.md");
		expect(readme).toContain("sox");
		expect(readme).toContain("ffmpeg");
		expect(readme).toContain("arecord");
	});

	test("package.json has correct metadata", () => {
		const pkg = JSON.parse(read("package.json"));
		expect(pkg.name).toBe("pi-voicekit");
		expect(pkg.pi?.extensions).toContain("./extensions/voice.ts");
		expect(pkg.keywords).toContain("pi-extension");
		expect(pkg.keywords).not.toContain("deepgram");
		expect(pkg.keywords).toContain("privacy");
	});
});
