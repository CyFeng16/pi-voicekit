import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, type VoiceConfig } from "../extensions/voice/config";
import { detectDevice, getModelFitness } from "../extensions/voice/device";
import { PUNCTUATION_MODEL } from "../extensions/voice/punctuation-model";
import {
	addPunctuation,
	preparePunctuation,
	punctuateWithStatus,
	resetPunctuationForTest,
	spliceMarks,
	type PunctuationEngine,
} from "../extensions/voice/punctuation";
import { VoiceSettingsPanel } from "../extensions/voice/settings-panel";

// ─── Invariant 1: the step only inserts marks ────────────────────────────────

/** The scorer's mark set (spec invariant 1), written out here independently of the module. */
const MARK_SET = new Set([..."。！？；：、，,.!?;:"]);

function stripMarks(text: string): string {
	return Array.from(text)
		.filter((ch) => !MARK_SET.has(ch))
		.join("");
}

/** Is every character of `input` present in `output`, in order and unduplicated? */
function isSubsequence(input: string, output: string): boolean {
	const chars = Array.from(input);
	let index = 0;
	for (const ch of Array.from(output)) {
		if (index < chars.length && ch === chars[index]) index++;
	}
	return index === chars.length;
}

/** Both checks of spec invariant 1. */
function expectOnlyMarksInserted(input: string, output: string): void {
	expect(stripMarks(output)).toBe(stripMarks(input));
	expect(isSubsequence(input, output)).toBe(true);
}

// ─── Measured fixtures ───────────────────────────────────────────────────────

/**
 * Input and raw model output, recorded by the local mixed-language probe
 * (`~/.pi/voicekit-eval/scripts/punctuation-mixed.ts`, 2026-09-28, spec §9). The raw column is
 * what the model actually returned — identifiers broken (`base _ url`), CJK-boundary spaces
 * moved and existing marks doubled — which is why its string is never returned as it stands.
 */
const MEASURED: { name: string; input: string; raw: string; spliced: string }[] = [
	{
		name: "pure Chinese",
		input: "这个方案我认为可行但是需要先确认数据库连接池是否足够",
		raw: "这个方案我认为可行，但是需要先确认数据库连接池是否足够。",
		spliced: "这个方案我认为可行，但是需要先确认数据库连接池是否足够。",
	},
	{
		name: "Chinese with English terms",
		input: "这次我们用的是 axios 请求失败的时候要加 retry 逻辑",
		raw: "这次我们用的是axios，请求失败的时候要加retry逻辑。",
		// The input's own space is kept (invariant 1a) and the mark binds to the word before it, as
		// the model emitted it — `axios， 请求`, not `axios ，请求`.
		spliced: "这次我们用的是 axios， 请求失败的时候要加 retry 逻辑。",
	},
	{
		name: "code identifier base_url",
		input: "把 base_url 这个变量改成从配置文件里读不要写死",
		raw: "把base _ url这个变量改成从配置文件里读，不要写死。",
		spliced: "把 base_url 这个变量改成从配置文件里读，不要写死。",
	},
	{
		name: "spaced file path",
		input: "日志在 var log app 下面的 error 文件里可以查到",
		raw: "日志在var log app下面的error文件里可以查到。",
		spliced: "日志在 var log app 下面的 error 文件里可以查到。",
	},
	{
		name: "already punctuated",
		input: "这个方案可行，但是要先确认连接池。",
		raw: "这个方案可行，，但是要先确认连接池。。",
		spliced: "这个方案可行，但是要先确认连接池。",
	},
];

const DEFECTS = ["code identifier base_url", "spaced file path", "already punctuated"];

// ─── Splice ─────────────────────────────────────────────────────────────────

describe("spliceMarks — the measured model outputs", () => {
	for (const fixture of MEASURED) {
		test(`${fixture.name}: marks land in the untouched input`, () => {
			const result = spliceMarks(fixture.input, fixture.raw);
			expect(result).toBe(fixture.spliced);
			expectOnlyMarksInserted(fixture.input, result!);
		});

		test(`${fixture.name}: splicing the same model output again is a no-op`, () => {
			const once = spliceMarks(fixture.input, fixture.raw)!;
			expect(spliceMarks(once, fixture.raw)).toBe(once);
		});
	}

	test("never returns a raw output that breaks invariant 1 (the measured defects)", () => {
		for (const name of DEFECTS) {
			const fixture = MEASURED.find((candidate) => candidate.name === name)!;
			const result = spliceMarks(fixture.input, fixture.raw)!;
			expect(result).not.toBe(fixture.raw);
			expectOnlyMarksInserted(fixture.input, result);
		}
	});

	test("the raw space defects really break invariant 1, and the splice repairs them", () => {
		for (const name of ["code identifier base_url", "spaced file path"]) {
			const fixture = MEASURED.find((candidate) => candidate.name === name)!;
			// The raw output moved or dropped the input's whitespace, so check (a) fails on it —
			// the step must never hand that string on.
			expect(stripMarks(fixture.raw)).not.toBe(stripMarks(fixture.input));
			expectOnlyMarksInserted(fixture.input, spliceMarks(fixture.input, fixture.raw)!);
		}
	});

	test("the doubled mark is dropped, so an already-punctuated input comes back unchanged", () => {
		// A doubled mark passes both checks of invariant 1 by itself (both are about marks and
		// order) — dropping it is what the splice's duplicate rule exists for.
		const fixture = MEASURED.find((candidate) => candidate.name === "already punctuated")!;
		expect(fixture.raw).toContain("，，");
		expect(fixture.raw).toContain("。。");

		const result = spliceMarks(fixture.input, fixture.raw)!;
		expect(result).toBe(fixture.input);
		expect(result).not.toContain("，，");
		expect(result).not.toContain("。。");
	});

	test("keeps the identifier and the spaced path exactly", () => {
		const identifier = MEASURED.find((fixture) => fixture.name === "code identifier base_url")!;
		const spliced = spliceMarks(identifier.input, identifier.raw)!;
		expect(spliced).toContain("base_url");
		expect(spliced).not.toContain("base _ url");

		const spaced = MEASURED.find((fixture) => fixture.name === "spaced file path")!;
		const spacedResult = spliceMarks(spaced.input, spaced.raw)!;
		expect(spacedResult).toContain("var log app");
		expect(spacedResult).toContain("下面的 error 文件");
	});
});

describe("spliceMarks — refusals and edges", () => {
	test("refuses when the model output does not preserve the non-mark characters", () => {
		expect(spliceMarks("这个方案可行", "这个方案可以行。")).toBeUndefined(); // inserted a character
		expect(spliceMarks("这个方案可行", "方案这个可行。")).toBeUndefined(); // reordered the characters
		expect(spliceMarks("把 base_url 改成", "把 base url 改成。")).toBeUndefined(); // dropped the underscore
		expect(spliceMarks("把 base_url 改成", "把 base-url 改成。")).toBeUndefined(); // rewrote the underscore
	});

	test("keeps empty and whitespace-only input byte-identical", () => {
		expect(spliceMarks("", "")).toBe("");
		expect(spliceMarks("   ", "")).toBe("   ");
		expect(spliceMarks("", "   ")).toBe("");
		expect(spliceMarks("  \n ", "  \n ")).toBe("  \n ");
	});
});

// ─── punctuateWithStatus / addPunctuation ───────────────────────────────────

const punctuationEngine: PunctuationEngine = { addPunct: (text) => `${text}。` };

afterEach(() => {
	resetPunctuationForTest();
});

describe("punctuateWithStatus — fail-open paths", () => {
	test("no engine: the text is byte-identical and the reason is no-model", () => {
		resetPunctuationForTest();
		const result = punctuateWithStatus("这个方案可行", true);
		expect(result.text).toBe("这个方案可行");
		expect(result.status).toEqual({
			applied: false,
			reason: "no-model",
			marksBefore: 0,
			marksAfter: 0,
			elapsedMs: 0,
		});
	});

	test("shouldApply false: the gate already decided, so the engine is never called", () => {
		let calls = 0;
		resetPunctuationForTest({
			addPunct: (text) => {
				calls++;
				return `${text}。`;
			},
		});

		const result = punctuateWithStatus("这个方案可行", false);
		expect(result.text).toBe("这个方案可行");
		expect(result.status).toEqual({
			applied: false,
			reason: "not-needed",
			marksBefore: 0,
			marksAfter: 0,
			elapsedMs: 0,
		});
		expect(calls).toBe(0);
	});

	test("empty and whitespace-only input: nothing to punctuate", () => {
		let calls = 0;
		resetPunctuationForTest({
			addPunct: (text) => {
				calls++;
				return text;
			},
		});

		for (const text of ["", " ", "\n\t "]) {
			const result = punctuateWithStatus(text, true);
			expect(result.text).toBe(text);
			expect(result.status.applied).toBe(false);
			expect(result.status.reason).toBe("empty-input");
		}
		expect(calls).toBe(0);
	});

	test("a throwing engine leaves the text byte-identical and reports error", () => {
		resetPunctuationForTest({
			addPunct: () => {
				throw new Error("decode failed");
			},
		});

		for (const text of ["这个方案可行", "把 base_url 改成"]) {
			const result = punctuateWithStatus(text, true);
			expect(result.text).toBe(text);
			expect(result.status.applied).toBe(false);
			expect(result.status.reason).toBe("error");
			expect(result.status.marksAfter).toBe(result.status.marksBefore);
		}
	});

	test("an engine that alters characters is refused with altered-text", () => {
		resetPunctuationForTest({ addPunct: (text) => `${text}。并且和` });
		const result = punctuateWithStatus("这个方案可行", true);
		expect(result.text).toBe("这个方案可行");
		expect(result.status.applied).toBe(false);
		expect(result.status.reason).toBe("altered-text");
		expect(result.status.marksAfter).toBe(0);
	});

	test("applied: the splice lands, and marks and time are reported", () => {
		resetPunctuationForTest({ addPunct: (text) => text.replace("可行", "可行，") });
		const input = "这个方案可行但是要先确认连接池";
		const result = punctuateWithStatus(input, true);

		expect(result.text).toBe("这个方案可行，但是要先确认连接池");
		expect(result.status.applied).toBe(true);
		expect(result.status.reason).toBeUndefined();
		expect(result.status.marksBefore).toBe(0);
		expect(result.status.marksAfter).toBe(1);
		expect(result.status.elapsedMs).toBeGreaterThanOrEqual(0);
		expectOnlyMarksInserted(input, result.text);
	});
});

describe("addPunctuation", () => {
	test("inserts marks and is idempotent", () => {
		resetPunctuationForTest(punctuationEngine);
		const once = addPunctuation("这个方案可行", true);
		expect(once).toBe("这个方案可行。");
		expect(addPunctuation(once, true)).toBe(once);
	});

	test("returns the input unchanged when the gate says no", () => {
		resetPunctuationForTest(punctuationEngine);
		expect(addPunctuation("这个方案可行", false)).toBe("这个方案可行");
	});
});

// ─── preparePunctuation ─────────────────────────────────────────────────────

/**
 * Flush the microtask queue. `preparePunctuation` is fire-and-forget by design, so tests
 * observe its background work by yielding to the event loop, not by sleeping on a timer.
 */
async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("preparePunctuation — one background construction", () => {
	const createCountingEngine = (counter: { constructions: number }) => () => {
		counter.constructions++;
		return punctuationEngine;
	};

	test("does nothing when an engine is already constructed", async () => {
		resetPunctuationForTest(punctuationEngine);
		let lifecycleCalls = 0;
		preparePunctuation({
			ensure: async () => {
				lifecycleCalls++;
				return false;
			},
		});
		await settle();
		expect(lifecycleCalls).toBe(0);
		expect(punctuateWithStatus("这个方案可行", true).status.applied).toBe(true);
	});

	test("constructs the engine once however often a dictation calls it", async () => {
		resetPunctuationForTest(null);
		const counter = { constructions: 0 };
		for (let i = 0; i < 5; i++) {
			preparePunctuation({
				ensure: async () => true,
				modelDir: "/tmp/pi-voice-punct-test",
				createEngine: createCountingEngine(counter),
			});
		}
		await settle();
		expect(counter.constructions).toBe(1);
		expect(punctuateWithStatus("这个方案可行", true).status.applied).toBe(true);
	});

	test("shares one prepare between concurrent callers", async () => {
		resetPunctuationForTest(null);
		const counter = { constructions: 0 };
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const options = {
			ensure: async () => {
				await gate;
				return true;
			},
			modelDir: "/tmp/pi-voice-punct-test",
			createEngine: createCountingEngine(counter),
		};

		preparePunctuation(options);
		preparePunctuation(options);
		release();
		await settle();
		expect(counter.constructions).toBe(1);
	});

	test("constructs nothing until the model reports ready", async () => {
		resetPunctuationForTest(null);
		const counter = { constructions: 0 };
		preparePunctuation({
			ensure: async () => false,
			modelDir: "/tmp/pi-voice-punct-test",
			createEngine: createCountingEngine(counter),
		});
		await settle();

		expect(counter.constructions).toBe(0);
		const result = punctuateWithStatus("这个方案可行", true);
		expect(result.text).toBe("这个方案可行");
		expect(result.status.reason).toBe("no-model");
	});

	test("reports load-failed when construction throws, and retries on the next prepare", async () => {
		resetPunctuationForTest(null);
		let attempts = 0;
		const options = {
			ensure: async () => true,
			modelDir: "/tmp/pi-voice-punct-test",
			createEngine: (): PunctuationEngine => {
				attempts++;
				throw new Error("onnx runtime refused the graph");
			},
		};

		preparePunctuation(options);
		await settle();
		expect(attempts).toBe(1);
		expect(punctuateWithStatus("这个方案可行", true).status.reason).toBe("load-failed");

		preparePunctuation(options);
		await settle();
		expect(attempts).toBe(2);
	});

	test("never rejects when the model lifecycle throws", async () => {
		resetPunctuationForTest(null);
		preparePunctuation({
			ensure: async () => {
				throw new Error("disk on fire");
			},
		});
		await settle();
		expect(punctuateWithStatus("这个方案可行", true).status.reason).toBe("load-failed");
	});
});

// ─── Settings panel: the model is not a recogniser ──────────────────────────

/**
 * Step 6 of the brief: the Downloaded tab lists every directory under ~/.pi/models, and its two
 * activation paths write `config.localModel`. Activating the punctuation row, or choosing it as
 * the post-delete replacement, would make the extension try to default to a model that cannot
 * transcribe (spec §4.2).
 */
describe("settings panel — the punctuation model cannot be activated", () => {
	type Downloaded = { id: string; sizeMB: number };

	function makePanel(downloaded: Downloaded[], config: VoiceConfig = { ...DEFAULT_CONFIG }) {
		const panel = new VoiceSettingsPanel(
			{
				config,
				device: detectDevice(),
				cwd: process.cwd(),
				getModelFitness,
				getDownloadedModels: () => downloaded,
				deleteModel: (id: string) => {
					const index = downloaded.findIndex((model) => model.id === id);
					if (index >= 0) downloaded.splice(index, 1);
					return index >= 0;
				},
				isSherpaAvailable: () => true,
				formatDeviceSummary: () => "test device",
				saveConfig: () => {},
				clearRecognizerCache: () => {},
				resolveApiKey: () => undefined,
				deepgramLanguages: [],
				getPolishModels: () => [],
				getPolishScope: () => "global",
				getLastDictation: () => undefined,
			},
			2 // the Downloaded tab
		);
		return { panel, config };
	}

	test("the row is listed, but ↵ on it does not become the active model", () => {
		const downloaded: Downloaded[] = [
			{ id: PUNCTUATION_MODEL.id, sizeMB: 285 },
			{ id: "parakeet-v3", sizeMB: 671 },
		];
		const { panel, config } = makePanel(downloaded);
		config.backend = "deepgram";

		const punctRow = panel.render(100).find((line) => line.includes(PUNCTUATION_MODEL.id));
		expect(punctRow).toBeDefined();
		expect(punctRow!).not.toContain("active");

		panel.handleInput("\r"); // row 0 — the punctuation model
		expect(config.localModel).toBeUndefined();
		expect(config.backend).toBe("deepgram");

		panel.handleInput("\x1b[B"); // row 1 — a real recogniser
		panel.handleInput("\r");
		expect(config.localModel).toBe("parakeet-v3");
		expect(config.backend).toBe("local");
	});

	test("the post-delete replacement skips it in favour of a recogniser", () => {
		const downloaded: Downloaded[] = [
			{ id: "paraformer-zh", sizeMB: 900 },
			{ id: PUNCTUATION_MODEL.id, sizeMB: 285 },
			{ id: "sensevoice-small", sizeMB: 300 },
		];
		const { panel, config } = makePanel(downloaded);
		config.localModel = "paraformer-zh";

		panel.handleInput("x"); // arm the delete
		panel.handleInput("x"); // commit it

		expect(downloaded.map((model) => model.id)).toEqual([PUNCTUATION_MODEL.id, "sensevoice-small"]);
		expect(config.localModel).toBe("sensevoice-small");
	});

	test("the replacement is undefined when only the punctuation model is left", () => {
		const downloaded: Downloaded[] = [
			{ id: "paraformer-zh", sizeMB: 900 },
			{ id: PUNCTUATION_MODEL.id, sizeMB: 285 },
		];
		const { panel, config } = makePanel(downloaded);
		config.localModel = "paraformer-zh";

		panel.handleInput("x");
		panel.handleInput("x");

		expect(config.localModel).toBeUndefined();
	});
});
