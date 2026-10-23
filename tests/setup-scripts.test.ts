import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("documentation", () => {
	const retiredIdentifiers = /deepgram|dpgr\.am/i;

	test("README sells a local-only product", () => {
		const readme = read("README.md");
		expect(readme).not.toMatch(retiredIdentifiers);
		expect(readme).toContain("/voice-settings");
		expect(readme).toContain("/voice test");
		expect(readme.toLowerCase()).toContain("never leaves");
		expect(readme).toContain("active local model");
	});

	test("zh-CN README mirrors the local-only claim", () => {
		const readme = read("i18n/README.zh-CN.md");
		expect(readme).toContain("没有任何音频被传输到本机之外");
		expect(readme).toContain("不传输遥测、分析或崩溃上报数据：没有任何崩溃上报器，也没有远程日志。");
		expect(readme).not.toMatch(retiredIdentifiers);
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
