import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("documentation", () => {
	test("README sells a local-only product", () => {
		const readme = read("README.md");
		expect(readme).not.toMatch(/DEEPGRAM_API_KEY|dpgr\.am|api\.deepgram\.com/);
		expect(readme).toContain("/voice-settings");
		expect(readme).toContain("/voice test");
		expect(readme.toLowerCase()).toContain("never leaves");
		expect(readme).toContain("active local model");
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
