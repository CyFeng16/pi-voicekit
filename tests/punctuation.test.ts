import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG, type VoiceConfig } from "../extensions/voice/config";
import { detectDevice, getModelFitness } from "../extensions/voice/device";
import { ensurePunctuationModel, PUNCTUATION_MODEL } from "../extensions/voice/punctuation-model";
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

describe("spliceMarks — an occupied slot keeps the input's own mark", () => {
	test("drops the model's mark when the slot already carries a different one", () => {
		// Ruling R5: the model's mark is dropped whenever the slot is occupied, not only when the
		// occupant is the same mark. An already-punctuated input therefore keeps its own punctuation
		// instead of gaining a second, incompatible one (spec §7 non-goal).
		expect(spliceMarks("可行。", "可行，")).toBe("可行。");
		expect(spliceMarks("可行，", "可行。")).toBe("可行，");
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
 * Flush the microtask queue. `preparePunctuation` is fire-and-forget by design, so tests observe
 * its background work by yielding to the event loop, not by sleeping on a timer; the scheduler
 * `runOnMicrotask` below is what puts that work on the queue `settle()` drains.
 */
async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

/**
 * Test scheduler: queue the prepare on the microtask queue so `settle()` can flush it. Production
 * uses `setTimeout(task, 0)`; both start the work only once the caller's frame has unwound.
 */
const runOnMicrotask = (task: () => void): void => {
	void Promise.resolve().then(task);
};

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
		resetPunctuationForTest(null, runOnMicrotask);
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
		resetPunctuationForTest(null, runOnMicrotask);
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
		resetPunctuationForTest(null, runOnMicrotask);
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
		resetPunctuationForTest(null, runOnMicrotask);
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
		resetPunctuationForTest(null, runOnMicrotask);
		preparePunctuation({
			ensure: async () => {
				throw new Error("disk on fire");
			},
		});
		await settle();
		expect(punctuateWithStatus("这个方案可行", true).status.reason).toBe("load-failed");
	});
});

// ─── preparePunctuation: the caller's frame is yielded first ────────────────

describe("preparePunctuation — it yields the caller's stack before any work", () => {
	test("a present but unverified model is not hashed before the call returns", async () => {
		const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-voice-punct-unverified-"));
		try {
			// Exactly the state the review named: both files exist, but this process has not verified
			// them yet, so the real readiness check would hash model.onnx (~150 ms) on its first call.
			for (const name of Object.keys(PUNCTUATION_MODEL.sha256)) {
				fs.writeFileSync(path.join(modelDir, name), "present but not the measured bytes");
			}

			// The real lifecycle runs against these files with only its transfer stubbed out. A
			// synchronous entry into `ensurePunctuationModel` hashes the file and then reaches that
			// stub — all before `preparePunctuation` could return — so the transfer count is the
			// observable that proves the hash did not start in the caller's frame.
			let transfers = 0;
			const queued: (() => void)[] = [];
			let constructions = 0;
			resetPunctuationForTest(null, (task) => queued.push(task));

			// Three qualifying dictations, i.e. three calls before the queued work has started.
			for (let i = 0; i < 3; i++) {
				preparePunctuation({
					ensure: () =>
						ensurePunctuationModel({
							modelDir,
							download: () => {
								transfers++;
								return Promise.resolve("stub");
							},
						}),
					createEngine: () => {
						constructions++;
						return punctuationEngine;
					},
				});
			}

			// Nothing has run yet, and the three dictations queued exactly one prepare.
			expect(queued).toHaveLength(1);
			expect(transfers).toBe(0);
			expect(constructions).toBe(0);

			// The queued work does reach the real verification, which fails on the wrong bytes and
			// stops at the transfer — so the assertions above cannot pass by nothing ever running.
			queued[0]!();
			await settle();
			expect(transfers).toBe(1);
			expect(constructions).toBe(0);
			expect(punctuateWithStatus("这个方案可行", true).status.reason).toBe("no-model");
		} finally {
			fs.rmSync(modelDir, { recursive: true, force: true });
		}
	});

	test("the production scheduler starts the work only after the event loop turns", async () => {
		resetPunctuationForTest(null); // the default `setTimeout(task, 0)` scheduler
		let lifecycleCalls = 0;
		preparePunctuation({
			ensure: async () => {
				lifecycleCalls++;
				return false;
			},
		});

		expect(lifecycleCalls).toBe(0);
		for (let i = 0; i < 20 && lifecycleCalls === 0; i++) {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
		expect(lifecycleCalls).toBe(1);
	});
});

// ─── preparePunctuation: the unavailable hook ──────────────────────────────

/**
 * The failure notice has to distinguish "the download is still running" from "the prepare gave
 * up": `punctuateWithStatus` reports a failed transfer as `no-model` (the module's pinned
 * semantics), and the dictation path must not ask `isPunctuationModelReady()` because that hashes
 * the model on first call. The hook is therefore the one signal that covers a failed download, an
 * unverifiable file, a native-module load failure and a throwing construction (spec §4.6).
 */
describe("preparePunctuation — the unavailable hook", () => {
	test("reports a transfer that produced no model", async () => {
		resetPunctuationForTest(null, runOnMicrotask);
		let reported = 0;
		preparePunctuation({
			ensure: async () => false,
			onUnavailable: () => reported++,
		});
		await settle();

		expect(reported).toBe(1);
		expect(punctuateWithStatus("这个方案可行", true).status.reason).toBe("no-model");
	});

	test("reports a throwing construction, and reports each failed retry", async () => {
		resetPunctuationForTest(null, runOnMicrotask);
		let reported = 0;
		const options = {
			ensure: async () => true,
			modelDir: "/tmp/pi-voice-punct-test",
			createEngine: (): PunctuationEngine => {
				throw new Error("onnx runtime refused the graph");
			},
			onUnavailable: () => reported++,
		};

		preparePunctuation(options);
		await settle();
		expect(reported).toBe(1);
		expect(punctuateWithStatus("这个方案可行", true).status.reason).toBe("load-failed");

		// The next qualifying dictation retries the prepare — and reports again when it fails again.
		preparePunctuation(options);
		await settle();
		expect(reported).toBe(2);
	});

	test("stays silent when the prepare produced an engine", async () => {
		resetPunctuationForTest(null, runOnMicrotask);
		let reported = 0;
		preparePunctuation({
			ensure: async () => true,
			modelDir: "/tmp/pi-voice-punct-test",
			createEngine: () => punctuationEngine,
			onUnavailable: () => reported++,
		});
		await settle();

		expect(reported).toBe(0);
		expect(punctuateWithStatus("这个方案可行", true).status.applied).toBe(true);
	});

	test("a throwing hook cannot break the fail-open lifecycle", async () => {
		resetPunctuationForTest(null, runOnMicrotask);
		preparePunctuation({
			ensure: async () => false,
			onUnavailable: () => {
				throw new Error("the notice path threw");
			},
		});
		await settle();

		// The slot is free again and the step is still the plain `no-model` no-op.
		expect(punctuateWithStatus("这个方案可行", true).status.reason).toBe("no-model");
		let reported = 0;
		preparePunctuation({
			ensure: async () => true,
			modelDir: "/tmp/pi-voice-punct-test",
			createEngine: () => punctuationEngine,
			onUnavailable: () => reported++,
		});
		await settle();
		expect(reported).toBe(0);
		expect(punctuateWithStatus("这个方案可行", true).status.applied).toBe(true);
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

// ─── preparePunctuation — a warm start that never downloads ─────────────────

describe("preparePunctuation — requirePresent builds from what is already on disk", () => {
	const createCountingEngine = (counter: { constructions: number }) => () => {
		counter.constructions++;
		return punctuationEngine;
	};

	test("constructs from an already verified model", async () => {
		resetPunctuationForTest(null, runOnMicrotask);
		const counter = { constructions: 0 };
		let ensureCalls = 0;
		preparePunctuation({
			requirePresent: true,
			isReady: () => true,
			ensure: async () => {
				ensureCalls++;
				return true;
			},
			modelDir: "/tmp/pi-voice-punct-test",
			createEngine: createCountingEngine(counter),
		});
		await settle();
		expect(counter.constructions).toBe(1);
		expect(ensureCalls).toBe(1);
	});

	test("declines without transferring anything when the model is absent", async () => {
		resetPunctuationForTest(null, runOnMicrotask);
		const counter = { constructions: 0 };
		let ensureCalls = 0;
		let unavailable = 0;
		preparePunctuation({
			requirePresent: true,
			isReady: () => false,
			ensure: async () => {
				ensureCalls++;
				return true;
			},
			modelDir: "/tmp/pi-voice-punct-test",
			createEngine: createCountingEngine(counter),
			onUnavailable: () => {
				unavailable++;
			},
		});
		await settle();
		expect(ensureCalls).toBe(0);
		expect(counter.constructions).toBe(0);
		// A decline is not a failure: nothing was attempted, so no notice is owed and the reason
		// stays "no model" rather than "load failed".
		expect(unavailable).toBe(0);
		expect(punctuateWithStatus("这个方案可行", true).status.reason).toBe("no-model");
	});

	test("leaves the slot free so a dictation that needs the model can still fetch it", async () => {
		resetPunctuationForTest(null, runOnMicrotask);
		const counter = { constructions: 0 };
		let ready = false;
		let ensureCalls = 0;
		const ensure = async (): Promise<boolean> => {
			ensureCalls++;
			return true;
		};
		preparePunctuation({
			requirePresent: true,
			isReady: () => ready,
			ensure,
			modelDir: "/tmp/pi-voice-punct-test",
			createEngine: createCountingEngine(counter),
		});
		await settle();
		expect(ensureCalls).toBe(0);

		ready = true;
		preparePunctuation({ ensure, modelDir: "/tmp/pi-voice-punct-test", createEngine: createCountingEngine(counter) });
		await settle();
		expect(ensureCalls).toBe(1);
		expect(punctuateWithStatus("这个方案可行", true).status.applied).toBe(true);
	});

	test("reads nothing before the caller's stack has unwound", async () => {
		resetPunctuationForTest(null, runOnMicrotask);
		let readyChecks = 0;
		preparePunctuation({
			requirePresent: true,
			isReady: () => {
				readyChecks++;
				return true;
			},
			ensure: async () => true,
			modelDir: "/tmp/pi-voice-punct-test",
			createEngine: () => punctuationEngine,
		});
		expect(readyChecks).toBe(0);
		await settle();
		expect(readyChecks).toBe(1);
	});
});

// ─── preparePunctuation — the transfer hook ─────────────────────────────────

describe("preparePunctuation — onTransfer only fires when the model is missing", () => {
	test("reports a transfer when the model is not on disk", async () => {
		resetPunctuationForTest(null, runOnMicrotask);
		let transfers = 0;
		preparePunctuation({
			isReady: () => false,
			ensure: async () => true,
			modelDir: "/tmp/pi-voice-punct-test",
			createEngine: () => punctuationEngine,
			onTransfer: () => {
				transfers++;
			},
		});
		await settle();
		expect(transfers).toBe(1);
	});

	test("stays silent when the model is already on disk", async () => {
		resetPunctuationForTest(null, runOnMicrotask);
		let transfers = 0;
		preparePunctuation({
			isReady: () => true,
			ensure: async () => true,
			modelDir: "/tmp/pi-voice-punct-test",
			createEngine: () => punctuationEngine,
			onTransfer: () => {
				transfers++;
			},
		});
		await settle();
		expect(transfers).toBe(0);
		expect(punctuateWithStatus("这个方案可行", true).status.applied).toBe(true);
	});

	test("a warm start that declines reports nothing", async () => {
		resetPunctuationForTest(null, runOnMicrotask);
		let transfers = 0;
		preparePunctuation({
			requirePresent: true,
			isReady: () => false,
			modelDir: "/tmp/pi-voice-punct-test",
			onTransfer: () => {
				transfers++;
			},
		});
		await settle();
		expect(transfers).toBe(0);
	});

	test("a throwing hook cannot reach the lifecycle", async () => {
		resetPunctuationForTest(null, runOnMicrotask);
		preparePunctuation({
			isReady: () => false,
			ensure: async () => true,
			modelDir: "/tmp/pi-voice-punct-test",
			createEngine: () => punctuationEngine,
			onTransfer: () => {
				throw new Error("notice failed");
			},
		});
		await settle();
		expect(punctuateWithStatus("这个方案可行", true).status.applied).toBe(true);
	});
});
