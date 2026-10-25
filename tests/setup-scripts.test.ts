import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("documentation", () => {
	const retiredIdentifiers = /deepgram|dpgr\.am/i;

	/**
	 * The privacy claim and the one exception that narrows it. That exception is the user's own
	 * configuration rather than something the extension does: routing playback or capture to another
	 * host. It must sit in the same block as the claim — a reader who finds the claim without it
	 * believes nothing ever leaves the machine. The text a user submits is a different kind of
	 * statement: not an exception to the claim, but a fact the same block has to state, because a
	 * deleted exception must not take it down with it.
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

	/**
	 * Every shipped surface a reader can reach without opening the source tree. The claim has to be the
	 * narrowed one on all of them, not only in the README that the review read: the audit line in
	 * `SECURITY.md` and the package pitch on the npm page are read on their own.
	 */
	const SHIPPED_SURFACES = [
		"README.md",
		"i18n/README.zh-CN.md",
		"SECURITY.md",
		"llms.txt",
		"llms-full.txt",
		"docs/troubleshooting.md",
		"CHANGELOG.md",
		"package.json",
	];

	/**
	 * The absolutes the claim was narrowed away from. They may appear nowhere on a shipped surface.
	 *
	 * Two families had to be retired, so the pattern covers both: the "never leaves" verb
	 * ("…and your audio never leaves the machine") and the passive form that named the destination
	 * ("**No audio is transmitted off the machine.**"). Guarding only the first family left the second
	 * free to return: the positive assertions require the narrowed claim somewhere in the file, so a
	 * reverted sentence elsewhere on the same surface stays green.
	 *
	 * The README quotes one of them once on purpose ("narrower than 'nothing ever leaves the machine'")
	 * and `i18n/README.zh-CN.md` mirrors that quote. The exemption is structural rather than a list of
	 * allowed strings: the pattern needs `audio` as the subject, so the deliberate quote — whose subject
	 * is "nothing" — cannot fire it. The self-check below pins that.
	 */
	const OLD_ABSOLUTE =
		/\baudio\s+(?:never|ever|does\s?n[o']t)\s+leave?s?\b|\b(?:no\s+)?audio\s+(?:(?:is|was|gets)\s+|is\s?n[o']t\s+)?(?:(?:never|ever|not)\s+)?(?:transmitted|sent|uploaded|transferred)\s+(?:off|out\s+of)\s+(?:the|this|your)\s+(?:machine|host|computer)\b/i;

	test("README sells a local-only product", () => {
		const readme = read("README.md");
		expect(readme).not.toMatch(retiredIdentifiers);
		expect(readme).toContain("/voice-settings");
		expect(readme).toContain("/voice test");
		expect(readme).toContain(CLAIM_EN);
		expect(readme).toContain("active local model");
	});

	test("README names the single exception to the claim where the claim is made", () => {
		const block = exceptionBlock(read("README.md"), "## Privacy", CLAIM_EN);
		expect(block).toContain("System audio routing");
		expect(block).toContain("PULSE_SERVER");
		expect(block).not.toContain("Auto-submit");
		// The removed exception carried the text-path fact. Deleting it must not narrow the claim, so
		// the same block still has to say that what the user sends reaches Pi's model.
		expect(block).toContain("whatever model Pi is configured with");
	});

	test("zh-CN README mirrors the local-only claim", () => {
		const readme = read("i18n/README.zh-CN.md");
		expect(readme).toContain(CLAIM_ZH);
		expect(readme).toContain("不传输遥测、分析或崩溃上报数据：没有任何崩溃上报器，也没有远程日志。");
		expect(readme).not.toMatch(retiredIdentifiers);
	});

	test("zh-CN README carries the same single exception", () => {
		const block = exceptionBlock(read("i18n/README.zh-CN.md"), "## 隐私", CLAIM_ZH);
		expect(block).toContain("系统音频路由");
		expect(block).toContain("PULSE_SERVER");
		expect(block).not.toContain("自动提交");
		expect(block).toContain("Pi 所配置的模型");
	});

	test("SECURITY.md states the narrowed claim, under its own heading", () => {
		const security = read("SECURITY.md");
		// The heading itself is the guard: reverting it to the absolute has to fail a test, and this
		// file is where a security reader starts, not the README.
		expect(security).toContain(`### 1. ${CLAIM_EN.replace(/\.$/, "")}`);
		expect(security).toContain("System audio routing");
		expect(security).not.toContain("Auto-submit");
		expect(security).toContain("whichever model Pi is configured with");
	});

	test("no shipped surface carries the absolute the claim was narrowed away from", () => {
		const offenders = SHIPPED_SURFACES.filter((file) => OLD_ABSOLUTE.test(read(file)));
		expect(offenders).toEqual([]);
	});

	/**
	 * Guard-of-the-guard: a pattern that only caught one of the two retired families would look green
	 * over every shipped surface while leaving the other free to return. Check the pattern itself
	 * against both retired sentences, and against the one deliberate quote it has to spare.
	 */
	test("the retired-absolute pattern catches both retired families and spares the quote", () => {
		expect(OLD_ABSOLUTE.test("No key, no endpoint, no account — and your audio never leaves the machine.")).toBe(true);
		expect(OLD_ABSOLUTE.test("**No audio is transmitted off the machine.** Recording runs in-process.")).toBe(true);
		expect(OLD_ABSOLUTE.test(`it is narrower than "nothing ever leaves the machine".`)).toBe(false);
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

	/**
	 * The description is the one-line pitch on the npm page and in `npm info`, read by people who never
	 * open the README — so it has to carry the narrowed claim, not the absolute, and a regression there
	 * must fail here. Nothing else asserts this field.
	 */
	test("package.json description carries the narrowed claim", () => {
		const { description } = JSON.parse(read("package.json"));
		expect(typeof description).toBe("string");
		expect(description.toLowerCase()).toContain("no audio is uploaded to a remote speech service");
		expect(description).not.toMatch(OLD_ABSOLUTE);
	});
});
