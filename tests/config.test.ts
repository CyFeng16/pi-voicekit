import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import voiceExtension, { safeErrorText } from "../extensions/voice";
import { resetPunctuationForTest } from "../extensions/voice/punctuation";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_CONFIG,
	DEFAULT_TTS_LOCAL_MODEL,
	getGlobalSettingsPath,
	getProjectSettingsPath,
	loadConfigWithSource,
	needsOnboarding,
	saveConfig,
	saveGlobalVoiceFields,
	scrubRetiredVoiceKeys,
	VOICE_CONFIG_VERSION,
	type VoiceConfig,
} from "../extensions/voice/config";
import { getTtsModel, modelSupportsLanguage } from "../extensions/voice/tts-local-models";

const tempDirs: string[] = [];
/** `os.homedir` mocks that outlive their test body — see `runSessionStart`; restored in `afterEach`. */
const activeHomeSpies: Array<{ mockRestore(): void }> = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-voice-config-test-"));
	tempDirs.push(dir);
	return dir;
}

function writeSettings(baseDir: string, relativePath: string, voice: unknown) {
	const fullPath = path.join(baseDir, relativePath);
	fs.mkdirSync(path.dirname(fullPath), { recursive: true });
	fs.writeFileSync(fullPath, JSON.stringify({ voice }, null, 2));
}

/**
 * A controllable `/voice-speak` for the Escape and panel-close tests.
 *
 * Escape's playback-stop branch is only reachable while a playback indicator is mounted, and the real
 * indicator is mounted around a sherpa synthesis — which needs a downloaded TTS model and an audio
 * player. The mock returns a promise the test releases, so "playback in flight" is a state the test
 * owns. `runSpeak` is its only caller in this file.
 *
 * Two constraints shape the rest of it. Bun keeps ONE module registry for the whole `bun test` run, so a
 * bare `mock.module` here would also strip `chunkText` from `tests/speak.test.ts`; loading the real
 * module first and spreading it keeps every other export intact. And `mock.restore()` is deliberately
 * never called: it would also restore the `os.homedir` spy that keeps every settings write in this file
 * inside a temp directory, and a real `$HOME` write is the one thing these tests must never risk.
 */
interface ControlledPlayback {
	readonly signal: AbortSignal | undefined;
	settled: boolean;
	release(): void;
}

let pendingPlayback: ControlledPlayback | undefined;

const realSpeakModule = await import("../extensions/voice/speak");

mock.module("../extensions/voice/speak", () => ({
	...realSpeakModule,
	speak: (opts: { signal?: AbortSignal }) =>
		new Promise<void>((resolve) => {
			const playback: ControlledPlayback = {
				signal: opts.signal,
				settled: false,
				release: () => {
					playback.settled = true;
					pendingPlayback = undefined;
					resolve();
				},
			};
			pendingPlayback = playback;
		}),
}));

/** The playback `/voice-speak` just started; throws when the synthesis was never reached. */
function takePlayback(): ControlledPlayback {
	const playback = pendingPlayback;
	if (!playback) throw new Error("/voice-speak did not reach the synthesis stage");
	pendingPlayback = undefined;
	return playback;
}

/** Poll until `check()` holds — F1 opens help from a promise the input handler does not await. */
async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for the expected state");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

afterEach(() => {
	// A test that failed before releasing its `/voice-speak` promise must not leave the render ticker
	// armed for the rest of the file.
	pendingPlayback?.release();
	// Restore before removing the directories the mocks point at.
	for (const spy of activeHomeSpies.splice(0)) spy.mockRestore();
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("loadConfigWithSource", () => {
	test("returns defaults with incomplete onboarding when no settings exist", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");

		const result = loadConfigWithSource(cwd, { agentDir });

		expect(result.source).toBe("default");
		expect(result.config.enabled).toBe(true);
		expect(result.config.onboarding.completed).toBe(false);
		expect(result.config.scope).toBe("global");
		expect(result.config.language).toBe("zh");
	});

	test("keeps English when the settings file asks for it — the Chinese default only fills an absent key", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(agentDir, "settings.json", { enabled: true, language: "en" });

		const result = loadConfigWithSource(cwd, { agentDir });

		expect(result.config.language).toBe("en");
	});

	test("the default TTS model speaks the default dictation language", () => {
		const model = getTtsModel(DEFAULT_TTS_LOCAL_MODEL);

		expect(modelSupportsLanguage(model, DEFAULT_CONFIG.language)).toBe(true);
		expect(model.incompatible).toBeUndefined();
	});

	test("migrates a legacy global config whose raw backend and model keys are explicit", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		// `backend` and `model` are not typed fields any more, but `migrateConfig` still reads the raw
		// keys of an old file, so its owner keeps completed onboarding instead of being sent to setup.
		writeSettings(agentDir, "settings.json", {
			enabled: true,
			language: "en",
			backend: "deepgram",
			model: "nova-3",
		});

		const result = loadConfigWithSource(cwd, { agentDir });

		expect(result.source).toBe("global");
		expect(result.config.scope).toBe("global");
		expect(result.config.onboarding.completed).toBe(true);
		expect(result.config.onboarding.schemaVersion).toBe(result.config.version);
	});

	test("keeps onboarding incomplete for partial legacy config", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(agentDir, "settings.json", {
			enabled: true,
		});

		const result = loadConfigWithSource(cwd, { agentDir });

		expect(result.source).toBe("global");
		expect(result.config.onboarding.completed).toBe(false);
	});

	test("prefers project config over global config and preserves project scope", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(agentDir, "settings.json", {
			enabled: true,
			language: "en",
			backend: "deepgram",
			model: "nova-3",
		});
		writeSettings(cwd, ".pi/settings.json", {
			version: 2,
			enabled: true,
			language: "en",
			scope: "project",
			onboarding: {
				completed: true,
				schemaVersion: 2,
			},
		});

		const result = loadConfigWithSource(cwd, { agentDir });

		expect(result.source).toBe("project");
		expect(result.config.scope).toBe("project");
	});
});

describe("needsOnboarding", () => {
	test("suppresses the startup prompt for a recent remind-me-later marker", () => {
		const config: VoiceConfig = {
			...DEFAULT_CONFIG,
			onboarding: {
				...DEFAULT_CONFIG.onboarding,
				skippedAt: new Date().toISOString(),
			},
		};

		expect(needsOnboarding(config, "default")).toBe(false);
	});

	test("requires onboarding again once the remind-me-later window expires", () => {
		const config: VoiceConfig = {
			...DEFAULT_CONFIG,
			onboarding: {
				...DEFAULT_CONFIG.onboarding,
				skippedAt: new Date(Date.now() - 1000 * 60 * 60 * 25).toISOString(),
			},
		};

		expect(needsOnboarding(config, "default")).toBe(true);
	});
});

describe("saveConfig", () => {
	test("writes global settings when scope is global", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		const config: VoiceConfig = {
			...DEFAULT_CONFIG,
			scope: "global",
			onboarding: {
				completed: true,
				schemaVersion: DEFAULT_CONFIG.version,
			},
		};

		const savedPath = saveConfig(config, "global", cwd, { agentDir });
		const saved = JSON.parse(fs.readFileSync(savedPath, "utf8"));

		expect(savedPath).toBe(path.join(agentDir, "settings.json"));
		expect(saved.voice.scope).toBe("global");
	});

	test("writes project settings when scope is project", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		const config: VoiceConfig = {
			...DEFAULT_CONFIG,
			scope: "project",
			onboarding: {
				completed: true,
				schemaVersion: DEFAULT_CONFIG.version,
			},
		};

		const savedPath = saveConfig(config, "project", cwd, { agentDir });
		const saved = JSON.parse(fs.readFileSync(savedPath, "utf8"));

		expect(savedPath).toBe(path.join(cwd, ".pi", "settings.json"));
		expect(saved.voice.scope).toBe("project");
	});

	test("atomic write leaves no .tmp files after save", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		const config: VoiceConfig = {
			...DEFAULT_CONFIG,
			onboarding: { completed: true, schemaVersion: DEFAULT_CONFIG.version },
		};

		const savedPath = saveConfig(config, "global", cwd, { agentDir });
		const dir = path.dirname(savedPath);
		const tmpFiles = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));

		expect(tmpFiles).toHaveLength(0);
		expect(JSON.parse(fs.readFileSync(savedPath, "utf8"))).toBeDefined();
	});
});

describe("saveGlobalVoiceFields", () => {
	test("patches one key and leaves every other key of the global voice block untouched", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(agentDir, "settings.json", {
			version: 2,
			ttsSpeed: 0.8,
			autoSubmitOnSpeak: true,
			holdThresholdMs: 450,
			ttsLanguage: "zh",
			ttsLocalVoiceId: 7,
		});

		const savedPath = saveGlobalVoiceFields({ punctuationNoticeShown: true }, { agentDir });
		const saved = JSON.parse(fs.readFileSync(savedPath, "utf8")) as { voice: Record<string, unknown> };

		expect(saved.voice.punctuationNoticeShown).toBe(true);
		expect(saved.voice.version).toBe(2); // the existing schema version is kept
		expect(saved.voice.onboarding).toBeUndefined(); // patching must not invent an onboarding block
		expect(saved.voice.ttsSpeed).toBe(0.8);
		expect(saved.voice.autoSubmitOnSpeak).toBe(true);
		expect(saved.voice.holdThresholdMs).toBe(450);
		expect(saved.voice.ttsLanguage).toBe("zh");
		expect(saved.voice.ttsLocalVoiceId).toBe(7);
	});

	test("creates the file and the voice block when neither exists", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");

		const savedPath = saveGlobalVoiceFields({ punctuationNoticeShown: true }, { agentDir });
		const saved = JSON.parse(fs.readFileSync(savedPath, "utf8")) as { voice: Record<string, unknown> };

		expect(saved.voice.punctuationNoticeShown).toBe(true);
		expect(saved.voice.version).toBe(VOICE_CONFIG_VERSION);
		expect(saved.voice.onboarding).toBeUndefined(); // no onboarding block is created
		expect(Object.keys(saved.voice).sort()).toEqual(["punctuationNoticeShown", "version"]);
	});

	test("preserves the other keys of the settings file when creating the voice block", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		const settingsPath = path.join(agentDir, "settings.json");
		fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
		fs.writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }, null, 2));

		saveGlobalVoiceFields({ punctuationNoticeShown: false }, { agentDir });
		const saved = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
			theme: string;
			voice: Record<string, unknown>;
		};

		expect(saved.theme).toBe("dark");
		expect(saved.voice.punctuationNoticeShown).toBe(false);
	});

	test("merges the validated read without reading settings again", () => {
		const agentDir = makeTempDir();
		const settingsPath = path.join(agentDir, "settings.json");
		fs.writeFileSync(settingsPath, JSON.stringify({ theme: "dark", voice: { ttsSpeed: 0.8 } }));
		const read = fs.readFileSync;
		let reads = 0;
		const spy = spyOn(fs, "readFileSync").mockImplementation(((file: unknown, ...args: unknown[]) => {
			if (file === settingsPath && ++reads > 1) throw new Error("second read failed");
			return (read as Function)(file, ...args);
		}) as typeof fs.readFileSync);
		try {
			saveGlobalVoiceFields({ punctuationNoticeShown: false }, { agentDir });
			expect(reads).toBe(1);
		} finally {
			spy.mockRestore();
		}
		expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toMatchObject({
			theme: "dark",
			voice: { ttsSpeed: 0.8, punctuationNoticeShown: false },
		});
	});

	test("leaves a damaged settings file untouched instead of replacing it", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		const settingsPath = path.join(agentDir, "settings.json");
		fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
		// Unparseable (a trailing comma) but present — not the same thing as missing.
		const damaged = '{\n  "voice": { "ttsSpeed": 0.8, },\n  "theme": "dark"\n}\n';
		fs.writeFileSync(settingsPath, damaged);

		// The writer must refuse rather than merge into an empty object: a merge would
		// drop the voice block's other keys and the file's top-level keys with it.
		const original = process.stderr.write;
		let report = "";
		process.stderr.write = ((chunk: string | Uint8Array) => {
			report += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
			return true;
		}) as typeof process.stderr.write;
		try {
			expect(() => saveGlobalVoiceFields({ punctuationNoticeShown: true }, { agentDir })).toThrow();
		} finally {
			process.stderr.write = original;
		}

		expect(fs.readFileSync(settingsPath, "utf8")).toBe(damaged);
		expect(report).toContain("not writing");
	});
});

describe("punctuation and cleanup switches (scope-agnostic, default true)", () => {
	test("defaults to enabled", () => {
		const cwd = makeTempDir();
		const result = loadConfigWithSource(cwd, { agentDir: path.join(cwd, "agent-home") });
		expect(result.config.punctuationEnabled).toBe(true);
	});

	test("round-trips an explicit false through a global save", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		saveConfig({ ...DEFAULT_CONFIG, scope: "global", punctuationEnabled: false }, "global", cwd, { agentDir });

		const result = loadConfigWithSource(cwd, { agentDir });
		expect(result.source).toBe("global");
		expect(result.config.punctuationEnabled).toBe(false);
	});

	test("a global false beats a project block that re-enables punctuationEnabled", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(agentDir, "settings.json", { version: 4, punctuationEnabled: false });
		writeSettings(cwd, ".pi/settings.json", { version: 4, punctuationEnabled: true });

		const result = loadConfigWithSource(cwd, { agentDir });
		expect(result.source).toBe("project");
		expect(result.config.punctuationEnabled).toBe(false);
	});

	test("both cleanup switches default to true", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		const inherited = loadConfigWithSource(cwd, { agentDir });
		expect(inherited.config.fillerRemovalEnabled).toBe(true);
		expect(inherited.config.numeralNormalizationEnabled).toBe(true);
	});

	test("a global false beats a project block that re-enables fillerRemovalEnabled", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(agentDir, "settings.json", { version: 4, fillerRemovalEnabled: false });
		writeSettings(cwd, ".pi/settings.json", { version: 4, fillerRemovalEnabled: true });

		const tightened = loadConfigWithSource(cwd, { agentDir });
		expect(tightened.source).toBe("project");
		expect(tightened.config.fillerRemovalEnabled).toBe(false);
	});

	test("a global false beats a project block that re-enables numeralNormalizationEnabled", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(agentDir, "settings.json", { version: 4, numeralNormalizationEnabled: false });
		writeSettings(cwd, ".pi/settings.json", { version: 4, numeralNormalizationEnabled: true });

		const result = loadConfigWithSource(cwd, { agentDir });
		expect(result.source).toBe("project");
		expect(result.config.numeralNormalizationEnabled).toBe(false);
	});

	test("an explicit project value still wins when the global value is true", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(agentDir, "settings.json", {
			version: 4,
			punctuationEnabled: true,
			fillerRemovalEnabled: true,
			numeralNormalizationEnabled: true,
		});
		writeSettings(cwd, ".pi/settings.json", {
			version: 4,
			punctuationEnabled: false,
			fillerRemovalEnabled: false,
			numeralNormalizationEnabled: false,
		});

		const result = loadConfigWithSource(cwd, { agentDir });
		expect(result.source).toBe("project");
		expect(result.config.punctuationEnabled).toBe(false);
		expect(result.config.fillerRemovalEnabled).toBe(false);
		expect(result.config.numeralNormalizationEnabled).toBe(false);
	});

	test("each switch reads its own project key", () => {
		// The two cases differ in which field is off, so crossing any two key names at the
		// call sites yields a wrong boolean in at least one case. The all-false case above
		// cannot tell the keys apart — only that all three are read.
		const scenarios = [
			{
				project: { punctuationEnabled: true, fillerRemovalEnabled: false, numeralNormalizationEnabled: false },
				expected: [true, false, false],
			},
			{
				project: { punctuationEnabled: false, fillerRemovalEnabled: true, numeralNormalizationEnabled: false },
				expected: [false, true, false],
			},
		] as const;

		for (const { project, expected } of scenarios) {
			const cwd = makeTempDir();
			const agentDir = path.join(cwd, "agent-home");
			writeSettings(agentDir, "settings.json", {
				version: 4,
				punctuationEnabled: true,
				fillerRemovalEnabled: true,
				numeralNormalizationEnabled: true,
			});
			writeSettings(cwd, ".pi/settings.json", { version: 4, ...project });

			const result = loadConfigWithSource(cwd, { agentDir });
			expect(result.source).toBe("project");
			expect(result.config.punctuationEnabled).toBe(expected[0]);
			expect(result.config.fillerRemovalEnabled).toBe(expected[1]);
			expect(result.config.numeralNormalizationEnabled).toBe(expected[2]);
		}
	});

	test("a project block that omits the field inherits a global false", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(agentDir, "settings.json", { version: 3, punctuationEnabled: false });
		writeSettings(cwd, ".pi/settings.json", { version: 3 });

		const result = loadConfigWithSource(cwd, { agentDir });
		expect(result.source).toBe("project");
		expect(result.config.punctuationEnabled).toBe(false);
	});

	test("a project block that omits the field keeps the default when the global block is silent", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(agentDir, "settings.json", { version: 3 });
		writeSettings(cwd, ".pi/settings.json", { version: 3 });

		const result = loadConfigWithSource(cwd, { agentDir });
		expect(result.source).toBe("project");
		expect(result.config.punctuationEnabled).toBe(true);
	});

	test("is not stripped from a project-scoped save", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		const savedPath = saveConfig({ ...DEFAULT_CONFIG, scope: "project", punctuationEnabled: false }, "project", cwd, {
			agentDir,
		});
		const saved = JSON.parse(fs.readFileSync(savedPath, "utf8")) as { voice: Record<string, unknown> };
		expect(saved.voice.punctuationEnabled).toBe(false);
	});

	test("a v3 config without the field loads and yields the default", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(agentDir, "settings.json", { version: 3, language: "zh" });

		const result = loadConfigWithSource(cwd, { agentDir });
		expect(result.config.punctuationEnabled).toBe(true);
	});
});

describe("punctuation notice flag (global-only, default false)", () => {
	test("defaults to false when no settings exist", () => {
		const cwd = makeTempDir();
		const result = loadConfigWithSource(cwd, { agentDir: path.join(cwd, "agent-home") });
		expect(result.config.punctuationNoticeShown).toBe(false);
	});

	test("is read from the global block even in a project-scoped session", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		// The flag describes the machine, so a project block must neither carry it nor hide it.
		writeSettings(agentDir, "settings.json", { version: 3, punctuationNoticeShown: true });
		writeSettings(cwd, ".pi/settings.json", { version: 3, punctuationNoticeShown: false });

		const result = loadConfigWithSource(cwd, { agentDir });
		expect(result.source).toBe("project");
		expect(result.config.punctuationNoticeShown).toBe(true);
	});

	test("is stripped from a project-scoped save", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		const savedPath = saveConfig(
			{ ...DEFAULT_CONFIG, scope: "project", punctuationNoticeShown: true },
			"project",
			cwd,
			{ agentDir }
		);

		const saved = JSON.parse(fs.readFileSync(savedPath, "utf8")) as { voice: Record<string, unknown> };
		expect(saved.voice.punctuationNoticeShown).toBeUndefined();
	});

	test("is written field by field into the global file", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		const savedPath = saveGlobalVoiceFields({ punctuationNoticeShown: true }, { agentDir });

		const saved = JSON.parse(fs.readFileSync(savedPath, "utf8")) as { voice: Record<string, unknown> };
		expect(saved.voice.punctuationNoticeShown).toBe(true);
	});
});

describe("v3 config migration (post-process keys removed in v4)", () => {
	// The five settings the LLM polish pass used. v4 ignores them but must never delete them
	// (spec §4.1, decision 10) — a user who rolls back to an older release finds them again.
	const LEGACY_POST_PROCESS_KEYS = [
		"postProcessEnabled",
		"postProcessModel",
		"postProcessContextTurns",
		"postProcessTimeoutMs",
		"postProcessNoticeShown",
	] as const;

	test("a v3 file with the removed postProcess* keys still loads, ignoring them", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(agentDir, "settings.json", {
			version: 3,
			postProcessEnabled: true,
			postProcessModel: "session",
			postProcessContextTurns: 2,
			postProcessTimeoutMs: 12000,
			postProcessNoticeShown: true,
			punctuationEnabled: false,
			onboarding: { completed: true, schemaVersion: 3 },
		});

		const result = loadConfigWithSource(cwd, { agentDir });

		expect(result.source).toBe("global");
		expect(result.config.version).toBe(VOICE_CONFIG_VERSION);
		expect(result.config.punctuationEnabled).toBe(false); // the surviving field is still read
		expect(result.config.onboarding.completed).toBe(true);
		// The removed keys are not part of the loaded object at all.
		expect("postProcessEnabled" in result.config).toBe(false);
		expect("postProcessModel" in result.config).toBe(false);
		expect("postProcessContextTurns" in result.config).toBe(false);
		expect("postProcessTimeoutMs" in result.config).toBe(false);
		expect("postProcessNoticeShown" in result.config).toBe(false);
	});

	test("the v3 → v4 bump does not re-trigger onboarding", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(agentDir, "settings.json", {
			version: 3,
			postProcessNoticeShown: true,
			onboarding: { completed: true, schemaVersion: 3 },
		});

		const result = loadConfigWithSource(cwd, { agentDir });

		expect(needsOnboarding(result.config, result.source)).toBe(false);
	});

	test("a global save keeps the legacy postProcess* keys already in the global file", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(agentDir, "settings.json", {
			version: 3,
			postProcessEnabled: false,
			postProcessModel: "session",
			postProcessContextTurns: 2,
			postProcessTimeoutMs: 12000,
			postProcessNoticeShown: true,
		});
		const loaded = loadConfigWithSource(cwd, { agentDir });
		// The runtime config ignores them even while the file carries them.
		for (const key of LEGACY_POST_PROCESS_KEYS) {
			expect(key in loaded.config).toBe(false);
		}

		const savedPath = saveConfig(loaded.config, "global", cwd, { agentDir });
		const saved = JSON.parse(fs.readFileSync(savedPath, "utf8")) as { voice: Record<string, unknown> };

		expect(saved.voice.version).toBe(VOICE_CONFIG_VERSION);
		expect(saved.voice.postProcessEnabled).toBe(false);
		expect(saved.voice.postProcessModel).toBe("session");
		expect(saved.voice.postProcessContextTurns).toBe(2);
		expect(saved.voice.postProcessTimeoutMs).toBe(12000);
		expect(saved.voice.postProcessNoticeShown).toBe(true);
	});

	test("a v3 project file's postProcess* keys are ignored and the punctuation scope rules still hold", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(agentDir, "settings.json", {
			version: 3,
			punctuationEnabled: false,
			punctuationNoticeShown: true,
		});
		writeSettings(cwd, ".pi/settings.json", {
			version: 3,
			postProcessEnabled: true,
			postProcessModel: "session",
			postProcessContextTurns: 2,
			postProcessTimeoutMs: 12000,
			postProcessNoticeShown: true,
			// Scope-agnostic switch: the project's explicit value wins over the global one,
			// except that a machine-wide false is final.
			punctuationEnabled: true,
			// Global-only flag: a project file must not be able to silence the notice.
			punctuationNoticeShown: false,
		});

		const result = loadConfigWithSource(cwd, { agentDir });

		expect(result.source).toBe("project");
		expect(result.config.version).toBe(VOICE_CONFIG_VERSION);
		// The global false is final, so the project's explicit true cannot re-enable it.
		expect(result.config.punctuationEnabled).toBe(false);
		expect(result.config.punctuationNoticeShown).toBe(true);
		for (const key of [
			"postProcessEnabled",
			"postProcessModel",
			"postProcessContextTurns",
			"postProcessTimeoutMs",
			"postProcessNoticeShown",
		]) {
			expect(key in result.config).toBe(false);
		}
	});

	test("a project save keeps the legacy postProcess* keys already in the project file", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(agentDir, "settings.json", { version: 3, punctuationEnabled: false });
		writeSettings(cwd, ".pi/settings.json", {
			version: 3,
			postProcessEnabled: true,
			postProcessNoticeShown: true,
		});

		const result = loadConfigWithSource(cwd, { agentDir });
		expect(result.source).toBe("project");
		expect(result.config.punctuationEnabled).toBe(false); // inherited from the global block, not the default

		const savedPath = saveConfig(result.config, "project", cwd, { agentDir });
		const saved = JSON.parse(fs.readFileSync(savedPath, "utf8")) as { voice: Record<string, unknown> };
		expect(saved.voice.version).toBe(VOICE_CONFIG_VERSION);
		expect(saved.voice.postProcessEnabled).toBe(true);
		expect(saved.voice.postProcessNoticeShown).toBe(true);
		// The switch is scope-agnostic and persists; the notice flag stays global-only.
		expect(saved.voice.punctuationEnabled).toBe(false);
		expect(saved.voice.punctuationNoticeShown).toBeUndefined();
	});

	test("a project save neither copies the global file's legacy keys nor touches that file", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(agentDir, "settings.json", {
			version: 3,
			postProcessEnabled: false,
			postProcessModel: "session",
			postProcessContextTurns: 1,
			postProcessTimeoutMs: 9000,
			postProcessNoticeShown: true,
		});
		writeSettings(cwd, ".pi/settings.json", { version: 3, postProcessModel: "rules" });

		const loaded = loadConfigWithSource(cwd, { agentDir });
		const savedPath = saveConfig(loaded.config, "project", cwd, { agentDir });
		const saved = JSON.parse(fs.readFileSync(savedPath, "utf8")) as { voice: Record<string, unknown> };
		expect(saved.voice.postProcessModel).toBe("rules");
		for (const key of LEGACY_POST_PROCESS_KEYS) {
			if (key === "postProcessModel") continue;
			expect(saved.voice[key]).toBeUndefined();
		}

		const global = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")) as {
			voice: Record<string, unknown>;
		};
		expect(global.voice.postProcessEnabled).toBe(false);
		expect(global.voice.postProcessModel).toBe("session");
	});

	test("a save into a file that never carried the legacy keys invents none", () => {
		// A fresh project file must not inherit the global file's legacy keys.
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(agentDir, "settings.json", {
			version: 3,
			postProcessEnabled: false,
			postProcessModel: "session",
			postProcessContextTurns: 1,
			postProcessTimeoutMs: 9000,
			postProcessNoticeShown: true,
		});
		const loaded = loadConfigWithSource(cwd, { agentDir });
		const savedPath = saveConfig(loaded.config, "project", cwd, { agentDir });
		const saved = JSON.parse(fs.readFileSync(savedPath, "utf8")) as { voice: Record<string, unknown> };
		expect(Object.keys(saved.voice).some((key) => key.startsWith("postProcess"))).toBe(false);

		// Nor may a fresh global file inherit the project file's legacy keys.
		const otherCwd = makeTempDir();
		const otherAgentDir = path.join(otherCwd, "agent-home");
		writeSettings(otherCwd, ".pi/settings.json", { version: 3, postProcessModel: "rules" });
		const projectLoaded = loadConfigWithSource(otherCwd, { agentDir: otherAgentDir });
		const globalSavedPath = saveConfig(projectLoaded.config, "global", otherCwd, { agentDir: otherAgentDir });
		const globalSaved = JSON.parse(fs.readFileSync(globalSavedPath, "utf8")) as { voice: Record<string, unknown> };
		expect(Object.keys(globalSaved.voice).some((key) => key.startsWith("postProcess"))).toBe(false);
	});
});

describe("v5 config migration (the cloud backend fields are gone)", () => {
	test("a project-scoped file carrying a retired key still loads and never prints the key", () => {
		// Review Focus #5: a hand-written project file can still name the retired keys. The loader
		// ignores them — it must resolve, must not throw, and must not echo the secret or the endpoint.
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(cwd, ".pi/settings.json", {
			version: 4,
			language: "zh",
			deepgramApiKey: "SECRET-project-key",
			localEndpoint: "http://10.0.0.5:8080",
		});

		const chunks: string[] = [];
		const original = process.stderr.write;
		process.stderr.write = ((chunk: string | Uint8Array) => {
			chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
			return true;
		}) as typeof process.stderr.write;
		try {
			const result = loadConfigWithSource(cwd, { agentDir });
			expect(result.source).toBe("project");
			expect(result.config.language).toBe("zh");
			// Ignored, not honoured: neither retired key reaches the runtime config.
			expect("deepgramApiKey" in result.config).toBe(false);
			expect("localEndpoint" in result.config).toBe(false);
		} finally {
			process.stderr.write = original;
		}

		expect(chunks.join("")).not.toContain("SECRET-project-key");
		expect(chunks.join("")).not.toContain("10.0.0.5");
	});
});

describe("v6 config migration (the auto-submit switch is gone)", () => {
	test("the config schema version is 6", () => {
		expect(VOICE_CONFIG_VERSION).toBe(6);
	});

	test("a config carrying a removed switch loads without it, whatever its type", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(agentDir, "settings.json", { enabled: true, autoSubmitOnSpeak: "yes" });

		const result = loadConfigWithSource(cwd, { agentDir });

		expect("autoSubmitOnSpeak" in (result.config as unknown as Record<string, unknown>)).toBe(false);
	});

	test("a full save drops the removed switch, keeps other settings, and keeps postProcess keys", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(agentDir, "settings.json", {
			enabled: true,
			localModel: "paraformer-zh",
			ttsSpeed: 0.8,
			autoSubmitOnSpeak: true,
			postProcessEnabled: true,
		});

		const loaded = loadConfigWithSource(cwd, { agentDir });
		saveConfig(loaded.config, "global", cwd, { agentDir, loadedSource: loaded.source });
		const after = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")).voice;

		expect(Object.hasOwn(after, "autoSubmitOnSpeak")).toBe(false);
		expect(after.localModel).toBe("paraformer-zh");
		expect(after.ttsSpeed).toBe(0.8);
		expect(after.postProcessEnabled).toBe(true);
	});

	test("an upgraded install keeps onboarding complete and stamps version 6 only on save", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(agentDir, "settings.json", { onboarding: { completed: true, schemaVersion: 5 } });

		const loaded = loadConfigWithSource(cwd, { agentDir });

		expect(loaded.config.onboarding.completed).toBe(true);
		expect(loaded.config.onboarding.schemaVersion).toBe(5);
		expect(needsOnboarding(loaded.config, loaded.source)).toBe(false);

		saveConfig(loaded.config, "global", cwd, { agentDir, loadedSource: loaded.source });
		const after = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")).voice;
		expect(after.onboarding.schemaVersion).toBe(VOICE_CONFIG_VERSION);
	});

	test("a project file's removed switch is not copied into the global block", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(agentDir, "settings.json", { onboarding: { completed: true } });
		writeSettings(cwd, ".pi/settings.json", { scope: "project", autoSubmitOnSpeak: true });

		const loaded = loadConfigWithSource(cwd, { agentDir });
		expect(loaded.source).toBe("project");

		saveConfig(loaded.config, "global", cwd, { agentDir, loadedSource: loaded.source });
		const globalVoice = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")).voice;

		expect(Object.hasOwn(globalVoice, "autoSubmitOnSpeak")).toBe(false);
	});
});

describe("agent directory (Pi's config-directory override)", () => {
	// Pi derives this variable from its product name (PI_CODING_AGENT_DIR for `pi`), so a rebranded
	// build uses a different one. The extension must ask Pi rather than reimplement the rule.
	const ENV = "PI_CODING_AGENT_DIR";

	test("follows the override instead of a hardcoded ~/.pi/agent", () => {
		const previous = process.env[ENV];
		process.env[ENV] = "/tmp/pi-voicekit-agent-dir-override";
		try {
			expect(getGlobalSettingsPath()).toBe("/tmp/pi-voicekit-agent-dir-override/settings.json");
		} finally {
			if (previous === undefined) delete process.env[ENV];
			else process.env[ENV] = previous;
		}
	});

	test("defaults to Pi's own agent directory when the override is absent", () => {
		const previous = process.env[ENV];
		delete process.env[ENV];
		try {
			expect(getGlobalSettingsPath()).toBe(path.join(os.homedir(), CONFIG_DIR_NAME, "agent", "settings.json"));
		} finally {
			if (previous !== undefined) process.env[ENV] = previous;
		}
	});

	test("the project path uses Pi's config-directory name, not a literal .pi", () => {
		expect(getProjectSettingsPath("/repo")).toBe(path.join("/repo", CONFIG_DIR_NAME, "settings.json"));
	});

	test("the startup cleanup scrubs the file Pi is actually using", () => {
		// End-to-end for the bug this suite exists for: with the override set, the cleanup must land on
		// that directory's settings.json. If the path were still hardcoded, this would read the real
		// agent directory, find no retired key there and report nothing removed.
		const dir = makeTempDir();
		const settingsPath = path.join(dir, "settings.json");
		fs.writeFileSync(settingsPath, JSON.stringify({ voice: { deepgramApiKey: "dg_LEGACY" } }, null, 2));

		const previous = process.env[ENV];
		process.env[ENV] = dir;
		try {
			const result = scrubRetiredVoiceKeys(getGlobalSettingsPath());
			expect(result.removed).toEqual(["deepgramApiKey"]);
			expect(fs.readFileSync(settingsPath, "utf8")).not.toContain("dg_LEGACY");
		} finally {
			if (previous === undefined) delete process.env[ENV];
			else process.env[ENV] = previous;
		}
	});
});
describe("scrubRetiredVoiceKeys (the retired credentials are erased on startup)", () => {
	function writeRaw(dir: string, contents: unknown): string {
		const settingsPath = path.join(dir, "settings.json");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(settingsPath, JSON.stringify(contents, null, 2));
		return settingsPath;
	}

	test("removes a stored key and endpoint, leaving every other key untouched", () => {
		const settingsPath = writeRaw(makeTempDir(), {
			theme: "x",
			voice: {
				language: "zh",
				deepgramApiKey: "SECRET-0.5.x-key",
				localEndpoint: "http://10.0.0.5:8080",
				localModel: "paraformer-zh",
			},
		});

		const result = scrubRetiredVoiceKeys(settingsPath);

		expect(result.removed).toEqual(["deepgramApiKey", "localEndpoint"]);
		// The sentence is assembled in config.ts — the one file the egress gate exempts — so the
		// caller only ever displays it. It names the retired keys and the env var, and neither the
		// secret value nor the host may reach the notice. It also has to carry the claim the product
		// makes now: the first start of an upgrade is where a user is told what the extension promises,
		// so the old absolute must not survive in the notice itself. The one exception the claim
		// still has is pinned, and the retired one is pinned out: a notice that names a deleted
		// command either advertises it or counts an exception that no longer exists, exactly where
		// the user reads it, and nothing else asserts this sentence.
		expect(result.message).toContain("deepgramApiKey");
		expect(result.message).toContain("localEndpoint");
		expect(result.message).toContain("DEEPGRAM_API_KEY");
		expect(result.message).toContain("0.6.0");
		expect(result.message).toContain("~/.env.secrets");
		expect(result.message).toContain("no audio is uploaded to a remote speech service");
		expect(result.message).toMatch(/system audio routing/);
		expect(result.message).toMatch(/one exception/);
		expect(result.message).not.toMatch(/voice-autosubmit/);
		expect(result.message).not.toMatch(/\baudio\s+(?:never|ever|does\s?n[o']t)\s+leave?s?\b/i);
		expect(result.message).not.toContain("SECRET-0.5.x-key");
		expect(result.message).not.toContain("10.0.0.5");

		const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
		expect(after.theme).toBe("x");
		expect(after.voice.language).toBe("zh");
		expect(after.voice.localModel).toBe("paraformer-zh");
		expect("deepgramApiKey" in after.voice).toBe(false);
		expect("localEndpoint" in after.voice).toBe(false);
	});

	test("creates no settings file when none exists", () => {
		const dir = makeTempDir();
		const settingsPath = path.join(dir, "settings.json");

		const result = scrubRetiredVoiceKeys(settingsPath);

		expect(result.removed).toEqual([]);
		expect(result.message).toBeUndefined();
		expect(fs.existsSync(settingsPath)).toBe(false);
		// Not even a stray temp file from the atomic writer.
		expect(fs.readdirSync(dir)).toEqual([]);
	});

	test("refuses to rewrite an unreadable settings file", () => {
		const dir = makeTempDir();
		const settingsPath = path.join(dir, "settings.json");
		fs.writeFileSync(settingsPath, "{ not json");

		expect(() => scrubRetiredVoiceKeys(settingsPath)).toThrow(/unread|refus/i);
		expect(fs.readFileSync(settingsPath, "utf8")).toBe("{ not json");
	});

	test("is idempotent", () => {
		const settingsPath = writeRaw(makeTempDir(), {
			voice: { language: "zh", deepgramApiKey: "SECRET-0.5.x-key", localEndpoint: "http://10.0.0.5:8080" },
		});

		expect(scrubRetiredVoiceKeys(settingsPath).removed).toEqual(["deepgramApiKey", "localEndpoint"]);
		const afterFirst = fs.readFileSync(settingsPath, "utf8");

		const second = scrubRetiredVoiceKeys(settingsPath);

		// No second notice and no second write: the caller keys the notice on `removed`.
		expect(second.removed).toEqual([]);
		expect(second.message).toBeUndefined();
		expect(fs.readFileSync(settingsPath, "utf8")).toBe(afterFirst);
	});

	test("does not rewrite a settings file with nothing to remove", () => {
		// Two shapes reach the same no-op branch: a block that never carried a retired key, and a
		// file with no voice block at all. Neither may be reformatted or rewritten.
		const withVoice = JSON.stringify({ voice: { language: "zh", localModel: "paraformer-zh" } }, null, 2);
		const voicePath = path.join(makeTempDir(), "settings.json");
		fs.writeFileSync(voicePath, withVoice);
		expect(scrubRetiredVoiceKeys(voicePath)).toEqual({ removed: [] });
		expect(fs.readFileSync(voicePath, "utf8")).toBe(withVoice);

		const withoutVoice = JSON.stringify({ theme: "x" }, null, 2);
		const plainPath = path.join(makeTempDir(), "settings.json");
		fs.writeFileSync(plainPath, withoutVoice);
		expect(scrubRetiredVoiceKeys(plainPath)).toEqual({ removed: [] });
		expect(fs.readFileSync(plainPath, "utf8")).toBe(withoutVoice);
	});

	// The scrub deletes two keys; every other byte of the file must survive, including values a
	// JavaScript number cannot carry. A `JSON.parse` → `JSON.stringify` round trip is lossy
	// (`9007199254740993` renders as `...992`, `1e400` as `null`), so these tests assert on the raw
	// text of the rewritten file rather than on its parsed value, and write the file as raw text too.
	function writeRawText(contents: string): string {
		const settingsPath = path.join(makeTempDir(), "settings.json");
		fs.writeFileSync(settingsPath, contents);
		return settingsPath;
	}

	function neighbourBlock(text: string): string {
		return text.slice(text.indexOf('"otherPlugin"'), text.indexOf('"voice"'));
	}

	test("preserves an integer beyond 2^53 in a neighbouring plugin's settings", () => {
		const raw = `{
	"theme": "x",
	"otherPlugin": {
		"id": 9007199254740993,
		"window": { "csv": "a, b}", "list": [1, 2, { "brace": "}" }] }
	},
	"voice": {
		"language": "zh",
		"deepgramApiKey": "SECRET-0.5.x-key",
		"localEndpoint": "http://10.0.0.5:8080",
		"localModel": "paraformer-zh"
	}
}
`;
		const settingsPath = writeRawText(raw);

		const result = scrubRetiredVoiceKeys(settingsPath);

		expect(result.removed).toEqual(["deepgramApiKey", "localEndpoint"]);
		const after = fs.readFileSync(settingsPath, "utf8");
		// 9007199254740993 is not representable: the round trip would store ...992 instead.
		expect(after).toContain('"id": 9007199254740993,');
		// Nested objects, arrays and strings holding `,` and `}` survive byte-for-byte, up to the block
		// the scrub is allowed to edit.
		expect(neighbourBlock(after)).toBe(neighbourBlock(raw));
		const parsed = JSON.parse(after);
		expect(parsed.voice.language).toBe("zh");
		expect(parsed.voice.localModel).toBe("paraformer-zh");
		expect("deepgramApiKey" in parsed.voice).toBe(false);
		expect("localEndpoint" in parsed.voice).toBe(false);
	});

	test("preserves a numeric literal outside the JavaScript number range", () => {
		const raw = `{
	"otherPlugin": { "limit": 1e400 },
	"voice": { "localEndpoint": "http://10.0.0.5:8080", "language": "zh" }
}
`;
		const settingsPath = writeRawText(raw);

		const result = scrubRetiredVoiceKeys(settingsPath);

		expect(result.removed).toEqual(["localEndpoint"]);
		const after = fs.readFileSync(settingsPath, "utf8");
		// `JSON.parse` turns this literal into Infinity and `JSON.stringify` writes it back as null.
		expect(after).toContain('"limit": 1e400');
		expect(after).not.toContain("null");
		expect(neighbourBlock(after)).toBe(neighbourBlock(raw));
		expect(JSON.parse(after).voice).toEqual({ language: "zh" });
	});
});

describe("settings writes keep the file's permissions", () => {
	// The scrub erases one credential and the writers reserialize the `voice` block next to every
	// other plugin's secrets. The temp file used to be created with no mode — 0666 & ~umask, i.e. 0644
	// on the common 022 umask — and the rename then replaced a 0600 settings file with it, handing
	// those secrets to every local user. Measured before the fix: 0600 became 0644 after a scrub.
	const PRIVATE = 0o600;

	function writePrivateSettings(dir: string, contents: string): string {
		const settingsPath = path.join(dir, "settings.json");
		fs.writeFileSync(settingsPath, contents, { mode: PRIVATE });
		// `writeFileSync`'s mode is masked by the umask; the assertion is about the mode on disk.
		fs.chmodSync(settingsPath, PRIVATE);
		return settingsPath;
	}

	test("a 0600 file stays 0600 across the scrub and a saveConfig-style write", () => {
		const agentDir = makeTempDir();
		const settingsPath = writePrivateSettings(
			agentDir,
			JSON.stringify(
				{
					voice: {
						enabled: true,
						language: "zh",
						deepgramApiKey: "SECRET-0.5.x-key",
						localEndpoint: "http://10.0.0.5:8080",
						onboarding: { completed: true, schemaVersion: 4 },
					},
				},
				null,
				2
			)
		);
		expect(fs.statSync(settingsPath).mode & 0o777).toBe(PRIVATE);

		expect(scrubRetiredVoiceKeys(settingsPath).removed).toEqual(["deepgramApiKey", "localEndpoint"]);
		expect(fs.statSync(settingsPath).mode & 0o777).toBe(PRIVATE);

		saveConfig({ ...DEFAULT_CONFIG, scope: "global", localModel: "parakeet-v3" }, "global", agentDir, {
			agentDir,
			loadedSource: "global",
		});
		expect(fs.statSync(settingsPath).mode & 0o777).toBe(PRIVATE);

		// The field-level writer shares the same path, so it has to land the same mode.
		saveGlobalVoiceFields({ punctuationNoticeShown: true }, { agentDir });
		expect(fs.statSync(settingsPath).mode & 0o777).toBe(PRIVATE);

		// No temp file survives at any mode.
		expect(fs.readdirSync(agentDir)).toEqual(["settings.json"]);
	});

	test("a wide-mode file planted at the historical temp path is never reused", () => {
		// The writer used to stage at `${settingsPath}.${pid}.tmp` with a plain `writeFileSync`, which
		// overwrites whatever already sits there — a crashed run's leftover, or a file another local
		// user planted — and `mode` is ignored for an existing file. Its permissions were therefore
		// kept, and the whole document (this file holds every other plugin's credentials) was written
		// into a wide-mode file before `chmodSync` tightened it. Every write opens a NEW path now, so a
		// plant must be neither read nor consumed.
		const agentDir = makeTempDir();
		const neighbourToken = "SECRET-NEIGHBOUR-TOKEN";
		const settingsPath = writePrivateSettings(
			agentDir,
			JSON.stringify(
				{
					otherPlugin: { token: neighbourToken },
					voice: { language: "zh", onboarding: { completed: true, schemaVersion: 4 } },
				},
				null,
				2
			)
		);
		const plantedPath = `${settingsPath}.${process.pid}.tmp`;
		const planted = "planted: never to be written into, or renamed away";
		fs.writeFileSync(plantedPath, planted, { mode: 0o666 });
		fs.chmodSync(plantedPath, 0o666);

		saveGlobalVoiceFields({ punctuationNoticeShown: true }, { agentDir });

		// The plant is untouched — same bytes, same mode — so the write cannot have reused the path.
		expect(fs.readFileSync(plantedPath, "utf8")).toBe(planted);
		expect(fs.statSync(plantedPath).mode & 0o777).toBe(0o666);

		// The write landed on the original path, private, carrying the neighbour's secret and none of
		// the plant: the text really did travel through the new private staging path.
		const after = fs.readFileSync(settingsPath, "utf8");
		expect(fs.statSync(settingsPath).mode & 0o777).toBe(PRIVATE);
		expect(after).toContain(neighbourToken);
		expect(after).not.toContain(planted);
		expect(JSON.parse(after).voice.punctuationNoticeShown).toBe(true);

		// No staging directory or file survives the write.
		expect(fs.readdirSync(agentDir).sort()).toEqual(["settings.json", `settings.json.${process.pid}.tmp`]);
	});

	test("a settings file created from nothing is private", () => {
		// No original to copy: the umask default would publish the block the user is about to fill
		// with settings for every plugin that shares the file.
		const agentDir = makeTempDir();

		saveGlobalVoiceFields({ punctuationNoticeShown: true }, { agentDir });

		expect(fs.statSync(path.join(agentDir, "settings.json")).mode & 0o777).toBe(PRIVATE);
	});
});

describe("/voice-speak-stop registration (regression)", () => {
	// There is no command harness: `extensions/voice.ts` registers its commands only when its
	// default export runs. This drives the real registration with a minimal mock, then executes
	// the captured handler. It pins that the command exists and that its handler routes through
	// `abortActiveSpeak` — it does not exercise live playback, whose state can only be set by
	// driving the TTS player.
	test("is registered and its handler reports no active speech when idle", async () => {
		const commands = new Map<string, { description?: string; handler: (args: string, cmdCtx: any) => Promise<void> }>();
		const pi = {
			on: () => {},
			registerShortcut: () => {},
			registerCommand: (name: string, definition: any) => commands.set(name, definition),
		} as any;

		// Hermetic: the real factory resolves its toggle shortcut from the global settings file, so
		// point the home directory at a temp dir for the call instead of reading the developer's
		// real `~/.pi/agent/settings.json`. No assertion below depends on that value.
		const homeSpy = spyOn(os, "homedir").mockReturnValue(makeTempDir());
		try {
			voiceExtension(pi);
		} finally {
			homeSpy.mockRestore();
		}

		const command = commands.get("voice-speak-stop");
		expect(command).toBeDefined();
		expect(command!.description).toBe("Stop in-flight TTS playback");

		const notices: Array<[string, string]> = [];
		await command!.handler("", {
			hasUI: true,
			ui: { notify: (message: string, type: string) => notices.push([message, type]) },
		});

		expect(notices).toEqual([["No active speech.", "info"]]);
	});

	test("its registration still calls abortActiveSpeak", () => {
		// Structural companion to the handler test above: reaching the idle notice requires
		// `abortActiveSpeak()` to return false, so pin the call as well.
		const source = fs.readFileSync(new URL("../extensions/voice.ts", import.meta.url), "utf8");
		const start = source.indexOf('pi.registerCommand("voice-speak-stop", {');
		expect(start).toBeGreaterThan(-1);
		const next = source.indexOf("pi.registerCommand(", start + 1);
		const block = source.slice(start, next === -1 ? undefined : next);
		expect(block).toContain("abortActiveSpeak()");
	});
});

describe("safeErrorText (cannot throw on a hostile thrown value)", () => {
	// Both of the upgrade notice's catch blocks log through this renderer: if it threw, the
	// persistence failure or the notice's own throw would escape and cost session initialisation.
	test("degrades to a fixed string for a value that cannot be stringified", () => {
		const hostile = Object.create(null) as any;
		hostile.toString = () => {
			throw new Error("toString is hostile");
		};
		expect(safeErrorText(hostile)).toBe("<unprintable error>");
		expect(safeErrorText(Object.create(null))).toBe("<unprintable error>");
	});

	test("keeps the ordinary renderings", () => {
		expect(safeErrorText("plain failure")).toBe("plain failure");
		expect(safeErrorText(new Error("boom"))).toContain("boom");
	});
});
describe("settings writes refuse to destroy a configuration they could not read", () => {
	// Incident this pins (2026-09-28): a session whose in-memory config was defaults — no settings
	// file carried a `voice` block — saved it over the global file, which DID carry the user's
	// block. backend, localModel and onboarding.completed were replaced by defaults, and the
	// extension then never wired hold-to-talk again. The writer must refuse that write.
	const richVoice = {
		version: 2,
		enabled: true,
		language: "zh",
		localModel: "paraformer-zh",
		onboarding: { completed: true, schemaVersion: 2 },
	};

	test("refuses to replace an existing voice block with defaults", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(agentDir, "settings.json", richVoice);

		expect(() =>
			saveConfig({ ...DEFAULT_CONFIG, scope: "global" }, "global", cwd, { agentDir, loadedSource: "default" })
		).toThrow(/unread|refus/i);

		const after = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
		expect(after.voice.localModel).toBe("paraformer-zh");
		expect(after.voice.onboarding.completed).toBe(true);
	});

	test("still writes when the caller reports a real source", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(agentDir, "settings.json", richVoice);

		const savedPath = saveConfig({ ...DEFAULT_CONFIG, scope: "global", language: "zh" }, "global", cwd, {
			agentDir,
			loadedSource: "global",
		});

		expect(savedPath).toBe(path.join(agentDir, "settings.json"));
		const after = JSON.parse(fs.readFileSync(savedPath, "utf8"));
		expect(after.voice.language).toBe("zh");
	});

	test("still writes defaults when the file carries no voice block", () => {
		// First install: the settings file exists (packages, theme) but nothing about voice, so a
		// default-derived config is the truth and must be persisted.
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }, null, 2));

		const savedPath = saveConfig({ ...DEFAULT_CONFIG, scope: "global" }, "global", cwd, {
			agentDir,
			loadedSource: "default",
		});

		const after = JSON.parse(fs.readFileSync(savedPath, "utf8"));
		expect(after.theme).toBe("dark");
		expect(after.voice.enabled).toBe(true);
	});

	test("refuses to overwrite a settings file it cannot parse", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		fs.mkdirSync(agentDir, { recursive: true });
		const settingsPath = path.join(agentDir, "settings.json");
		fs.writeFileSync(settingsPath, "{ this is not json");

		expect(() => saveConfig({ ...DEFAULT_CONFIG, scope: "global" }, "global", cwd, { agentDir })).toThrow(
			/unread|refus/i
		);
		expect(() => saveGlobalVoiceFields({ punctuationNoticeShown: true }, { agentDir })).toThrow(/unread|refus/i);
		expect(fs.readFileSync(settingsPath, "utf8")).toBe("{ this is not json");
	});
});

describe("session_start activation (the local model is the only path)", () => {
	// There is no session harness: `voice.ts` registers its lifecycle handlers when its default
	// export runs, so these tests drive the captured `session_start` handler. Two things make the
	// run hermetic — `os.homedir` points at a temp dir (the handler reads AND rewrites
	// `<home>/.pi/agent/settings.json` on migration), and the punctuation prepare's scheduler is
	// replaced with a no-op so a cold config can never start the ~285 MB model download mid-test.
	interface SessionHarness {
		notices: Array<[string, string]>;
		statuses: Array<[string, string | undefined]>;
		/** Every `ui.setWidget` call — a warm-up or recording widget is how a dictation shows itself. */
		readonly widgetCalls: Array<{ key: string; shown: boolean }>;
		/** Every `ui.custom` call: F1 help and the settings panel both open through it. */
		readonly customCalls: Array<{ overlay: boolean }>;
		/** The registered terminal input handler — see `sendInput`. */
		readonly terminalInputSubscribed: boolean;
		readonly settingsPath: string;
		joinedNotices(): string;
		/** Drive the real terminal input handler with raw bytes: press, repeat, release. */
		sendInput(data: string): unknown;
		/** The registered toggle shortcut — a recording entry that exists whether or not a hold is armed. */
		runToggleShortcut(): Promise<void>;
		/** Invoke `/voice-speak`; resolves when the mocked synthesis finishes — see `takePlayback`. */
		runSpeak(text: string): Promise<void>;
		/** Open the settings panel and close it; `visit` runs while the panel exists. */
		closePanel(visit?: (panel: any) => void): Promise<void>;
	}

	async function runSessionStart(
		voice: unknown,
		options: {
			projectVoice?: unknown;
			corruptGlobalSettings?: boolean;
			rawGlobalSettings?: string;
			/** Stub the TTS install marker under the mocked home so `/voice-speak` skips the install path. */
			ttsModelInstalled?: boolean;
		} = {}
	): Promise<SessionHarness> {
		const home = makeTempDir();
		const cwd = makeTempDir();
		const settingsPath = path.join(home, ".pi", "agent", "settings.json");
		if (options.corruptGlobalSettings) {
			// A file that exists but cannot be parsed — the one shape the scrub refuses to rewrite.
			fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
			fs.writeFileSync(settingsPath, "{ not json");
		} else if (options.rawGlobalSettings !== undefined) {
			// Raw text, not an object: these tests pin byte-exact survival of values `JSON.parse`
			// cannot round-trip, so the fixture has to be able to spell them verbatim.
			fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
			fs.writeFileSync(settingsPath, options.rawGlobalSettings);
		} else {
			writeSettings(home, ".pi/agent/settings.json", voice);
		}
		if (options.projectVoice !== undefined) writeSettings(cwd, ".pi/settings.json", options.projectVoice);

		// Kept for the harness's lifetime, not just the session_start call: every post-return helper
		// can write settings (`activateModel` saves), and an unmocked homedir would write the real
		// `~/.pi/agent/settings.json`. `afterEach` restores it.
		activeHomeSpies.push(spyOn(os, "homedir").mockReturnValue(home));
		if (options.ttsModelInstalled) {
			// The TTS model lookup resolves under the mocked home, so an install marker is enough to keep
			// `/voice-speak` off the (network) install path and inside the mocked synthesis.
			const ttsModelDir = path.join(home, ".pi", "models", "tts", DEFAULT_TTS_LOCAL_MODEL);
			fs.mkdirSync(ttsModelDir, { recursive: true });
			fs.writeFileSync(path.join(ttsModelDir, "tokens.txt"), "");
		}
		resetPunctuationForTest(null, () => {});
		try {
			const handlers = new Map<string, (event: any, sessionCtx: any) => Promise<void>>();
			const shortcuts = new Map<string, { handler: (ctx: any) => Promise<void> }>();
			const commands = new Map<string, { handler: (args: string, cmdCtx: any) => Promise<void> }>();
			const pi = {
				on: (name: string, handler: any) => handlers.set(name, handler),
				registerShortcut: (key: string, definition: any) => shortcuts.set(key, definition),
				registerCommand: (name: string, definition: any) => commands.set(name, definition),
			} as any;

			const notices: Array<[string, string]> = [];
			const statuses: Array<[string, string | undefined]> = [];
			const widgetCalls: Array<{ key: string; shown: boolean }> = [];
			const customCalls: Array<{ overlay: boolean }> = [];
			// One arming slot, like the real `terminalInputUnsub`: a new subscription replaces the
			// previous one and the returned unsubscriber clears it, so a test can tell armed from torn down.
			let armed = false;
			let inputHandler: ((data: string) => unknown) | undefined;
			let panelVisit: ((panel: any) => void) | undefined;
			const ui = {
				notify: (message: string, type: string) => notices.push([message, type]),
				setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
				setWidget: (key: string, content: unknown) => {
					widgetCalls.push({ key, shown: content !== undefined });
				},
				// No test in this file may start a recording: a real start snapshots the editor and then
				// spawns a capture tool. Throwing here turns that regression into a loud failure instead of
				// opening the microphone, and it pins the model guard upstream of the snapshot.
				getEditorText: () => {
					throw new Error("a recording was started: the editor snapshot ran");
				},
				setEditorText: () => {},
				onTerminalInput: (handler: (data: string) => unknown) => {
					armed = true;
					inputHandler = handler;
					return () => {
						armed = false;
						inputHandler = undefined;
					};
				},
				// The panel is built inside this callback, exactly as in a real session; returning no
				// action is a plain close.
				custom: async (
					factory: (tui: any, theme: any, kb: any, done: (action?: unknown) => void) => any,
					customOptions?: { overlay?: boolean }
				) => {
					customCalls.push({ overlay: !!customOptions?.overlay });
					const panel = factory(undefined, undefined, undefined, () => {});
					panelVisit?.(panel);
					return undefined;
				},
			};
			const sessionCtx = { hasUI: true, cwd, ui };

			voiceExtension(pi);
			const sessionStart = handlers.get("session_start");
			expect(sessionStart).toBeDefined();
			await sessionStart!({ reason: "startup" }, sessionCtx);

			return {
				notices,
				statuses,
				widgetCalls,
				customCalls,
				settingsPath,
				get terminalInputSubscribed() {
					return armed;
				},
				joinedNotices: () => notices.map(([message]) => message).join("\n"),
				sendInput(data: string) {
					if (!inputHandler) throw new Error("no terminal input handler is registered");
					return inputHandler(data);
				},
				async runToggleShortcut() {
					const shortcut = [...shortcuts.values()][0];
					expect(shortcut).toBeDefined();
					await shortcut!.handler({ hasUI: true, cwd, ui });
				},
				async runSpeak(text: string) {
					const command = commands.get("voice-speak");
					expect(command).toBeDefined();
					await command!.handler(text, { hasUI: true, cwd, ui });
				},
				async closePanel(visit) {
					panelVisit = visit;
					try {
						const command = commands.get("voice-setup");
						expect(command).toBeDefined();
						await command!.handler("", { hasUI: true, cwd, ui });
					} finally {
						panelVisit = undefined;
					}
				},
			};
		} finally {
			resetPunctuationForTest();
		}
	}

	test("a local model alone auto-activates hold-to-talk", async () => {
		const session = await runSessionStart({
			onboarding: { completed: true },
			localModel: "paraformer-zh",
			language: "zh",
		});

		// The completed branch keeps its historical silence (brief step 3: "behave as today"), so the
		// observable activation is the LOCAL status entry; the terminal input handler is registered in
		// every configuration and is asserted by the model-less tests below. What must not appear
		// anywhere is a cloud backend name.
		expect(session.terminalInputSubscribed).toBe(true);
		expect(session.statuses).toContainEqual(["voice", "MIC LOCAL"]);
		expect(session.joinedNotices()).not.toMatch(/deepgram|cloud|nova-3/i);
	});

	test("a local model without completed onboarding is migrated and activated", async () => {
		// The panel writes `localModel` and never writes `backend` any more; the activation predicate
		// must key on the model alone or the settings write succeeds and nothing ever activates.
		const session = await runSessionStart({ localModel: "paraformer-zh", language: "zh" });

		expect(session.terminalInputSubscribed).toBe(true);
		expect(session.joinedNotices()).toContain("Paraformer zh (bilingual)");
	});

	test("a completed config with no local model is sent to setup, not silently defaulted", async () => {
		// The shape every Deepgram user has after the upgrade: onboarding completed, no localModel.
		// "Completed" is not "configured" — the SPACE branch must not dictate on a default model, while
		// the terminal handler itself stays registered so F1 help and Escape keep working.
		const session = await runSessionStart({ onboarding: { completed: true }, backend: "deepgram" });

		expect(session.joinedNotices()).toContain("/voice-setup");
		expect(session.terminalInputSubscribed).toBe(true);
		expect(session.joinedNotices()).not.toMatch(/deepgram|cloud|nova-3/i);
	});

	test("no local model sends the user to setup instead of a dead backend", async () => {
		const session = await runSessionStart({});

		// The install hint is the only remaining entry point: one path, and it names the command that
		// opens the settings panel.
		expect(session.joinedNotices()).toContain("pi-voicekit installed");
		expect(session.joinedNotices()).toContain("/voice-setup");
		expect(session.joinedNotices()).not.toMatch(/deepgram|cloud|nova-3|two backends/i);
		expect(session.terminalInputSubscribed).toBe(true);
	});

	test("a scrub failure does not stop the session from wiring voice", async () => {
		// Review Focus #2: the credential scrub is best-effort. The global settings file it targets is
		// unparseable while this session's config comes from the project file, so activation still has
		// its local model and the scrub is the only thing that fails. The handler must warn, then keep
		// going to setupHoldToTalk() — a privacy cleanup may never cost dictation.
		const session = await runSessionStart(undefined, {
			corruptGlobalSettings: true,
			projectVoice: { onboarding: { completed: true }, localModel: "paraformer-zh", language: "zh" },
		});

		expect(session.terminalInputSubscribed).toBe(true);
		const warnings = session.notices.filter(([, type]) => type === "warning");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]![0]).toMatch(/settings file/i);
		expect(warnings[0]![0]).toMatch(/still on disk/i);
	});

	// ── The other top-level members of the file survive a full startup write sequence ─────────────
	//
	// The scrub deletes the retired members from the raw text, and the SAME session_start then writes
	// again: the punctuation notice's flag, and — on migration — the whole config. Both used to
	// reserialize the document, which destroyed every other plugin's `9007199254740993` (rendered as
	// ...992) and `1e400` (rendered as null) on every start until the notice was answered. These two
	// tests drive the real session_start sequence rather than the scrub alone, and compare the
	// neighbour's raw bytes, because the parsed value of those numbers is already wrong.
	function neighbourBytes(text: string): string {
		return text.slice(text.indexOf('"otherPlugin"'), text.indexOf('"voice"'));
	}

	test("a startup scrub plus the punctuation-notice write keeps a neighbour's numbers", async () => {
		const raw = `{
	"theme": "x",
	"otherPlugin": {
		"id": 9007199254740993,
		"limit": 1e400
	},
	"voice": {
		"version": 4,
		"enabled": true,
		"language": "zh",
		"localModel": "paraformer-zh",
		"deepgramApiKey": "SECRET-0.5.x-key",
		"localEndpoint": "http://10.0.0.5:8080",
		"onboarding": { "completed": true, "schemaVersion": 4 },
		"punctuationNoticeShown": false
	}
}
`;
		const session = await runSessionStart(undefined, { rawGlobalSettings: raw });

		const after = fs.readFileSync(session.settingsPath, "utf8");
		// Both writes of that startup really ran: the credentials are gone and the flag was persisted.
		const parsed = JSON.parse(after);
		expect(parsed.voice.punctuationNoticeShown).toBe(true);
		expect("deepgramApiKey" in parsed.voice).toBe(false);
		expect("localEndpoint" in parsed.voice).toBe(false);
		// ...and the neighbour is byte-for-byte what it was, including values no JS number can hold.
		expect(after).toContain('"id": 9007199254740993,');
		expect(after).toContain('"limit": 1e400');
		expect(after).not.toContain("null");
		expect(neighbourBytes(after)).toBe(neighbourBytes(raw));
	});

	test("a startup scrub plus the migration saveConfig keeps a neighbour's numbers", async () => {
		const raw = `{
	"theme": "x",
	"otherPlugin": { "id": 9007199254740993, "limit": 1e400 },
	"voice": {
		"version": 4,
		"language": "zh",
		"localModel": "paraformer-zh",
		"deepgramApiKey": "SECRET-0.5.x-key",
		"onboarding": { "completed": false, "schemaVersion": 4 }
	}
}
`;
		const session = await runSessionStart(undefined, { rawGlobalSettings: raw });

		const after = fs.readFileSync(session.settingsPath, "utf8");
		// The migration wrote the config (onboarding completed by it) and the scrub ran first.
		const parsed = JSON.parse(after);
		expect(parsed.voice.onboarding.completed).toBe(true);
		expect(parsed.voice.onboarding.source).toBe("migration");
		expect("deepgramApiKey" in parsed.voice).toBe(false);
		expect(after).toContain('"id": 9007199254740993,');
		expect(after).toContain('"limit": 1e400');
		expect(neighbourBytes(after)).toBe(neighbourBytes(raw));
	});

	// ── No entry point may record without an explicit local model ────────────────────────────────

	// The terminal input handler is registered in EVERY configuration, because only its SPACE branch needs
	// a model: F1 opens help and Escape cancels an install or stops speech, and both must keep working
	// while the user is still being told to pick one. These tests drive the real callback with the bytes
	// a terminal sends for a held key (Kitty CSI-u: press, repeat = 2, release = 3).
	const SPACE_PRESS = " ";
	const SPACE_REPEAT = "\x1b[32;1:2u";
	const SPACE_RELEASE = "\x1b[32;1:3u";
	const ESCAPE = "\x1b";
	const F1 = "\x1bOP";

	test("a recording entry with no configured model refuses to record", async () => {
		// `local.ts` substitutes DEFAULT_LOCAL_MODEL when no model was chosen, so an entry that starts
		// anyway would download and run Parakeet behind a warning that just told the user to pick one.
		const session = await runSessionStart({ onboarding: { completed: true }, backend: "deepgram" });

		// The toggle shortcut is a recording entry that exists whether or not a hold is armed. The
		// harness's `getEditorText` throws, and it is the first thing a real start does — so resolving
		// here is the proof that the refusal happened before any capture work began.
		await expect(session.runToggleShortcut()).resolves.toBeUndefined();

		expect(session.joinedNotices()).toContain("/voice-setup");
		expect(session.joinedNotices()).toContain("needs a local model");
		expect(session.statuses.filter(([, value]) => value?.startsWith("REC "))).toEqual([]);
		expect((globalThis as any).__piListen?.recording).not.toBe(true);
	});

	test("holding SPACE with no configured model warms up nothing and swallows nothing", async () => {
		// The timing path — press, repeats, the hold threshold, the release — driven through the real
		// callback. Before the model check moved inside the handler the whole callback was missing in
		// this state, so the previous round's "long press" test could not reach it at all.
		const session = await runSessionStart({ onboarding: { completed: true } });
		expect(session.terminalInputSubscribed).toBe(true);

		// A genuine hold: down, the repeats a held key produces, past the hold threshold, release.
		// `getEditorText` is still a tripwire, so any path into `startVoiceRecording` throws instead of
		// opening the microphone.
		expect(session.sendInput(SPACE_PRESS)).toBeUndefined();
		for (let repeat = 0; repeat < 8; repeat++) expect(session.sendInput(SPACE_REPEAT)).toBeUndefined();
		// Longer than HOLD_THRESHOLD_DEFAULT_MS (700 ms): a warmed-up hold would have started recording.
		await new Promise((resolve) => setTimeout(resolve, 800));
		expect(session.sendInput(SPACE_RELEASE)).toBeUndefined();

		// No warm-up widget, no recording state, nothing consumed: an ordinary press is still a space.
		expect(session.widgetCalls).toEqual([]);
		expect(session.statuses.filter(([, value]) => value === "MIC HOLD..." || value?.startsWith("REC "))).toEqual([]);
		expect((globalThis as any).__piListen?.recording).not.toBe(true);
	});

	test("the General tab navigates over four rows, not five", async () => {
		const session = await runSessionStart({ onboarding: { completed: true } });

		let rows = -1;
		await session.closePanel((panel) => {
			rows = (panel as any).getRowCount("general");
		});

		expect(rows).toBe(4);
	});

	test("F1 opens help with no configured model", async () => {
		// Help is advertised by the extension and has nothing to do with a model; the callback used to be
		// missing entirely, so the key fell through to the editor.
		const session = await runSessionStart({ onboarding: { completed: true } });

		expect(session.sendInput(F1)).toEqual({ consume: true });
		await waitUntil(() => session.customCalls.length === 1);
		expect(session.customCalls).toEqual([{ overlay: true }]);
	});

	test("Escape stops in-flight speech with no configured model", async () => {
		// `/voice-speak` is local and available before a model is chosen, and the indicator advertises
		// [esc]. Escape is handled before the SPACE branch, so the model gate must not reach it.
		const session = await runSessionStart(
			{ onboarding: { completed: true }, ttsEnabled: true },
			{
				ttsModelInstalled: true,
			}
		);
		const speaking = session.runSpeak("hello");
		await waitUntil(() => pendingPlayback !== undefined);
		const playback = takePlayback();
		expect(playback.signal?.aborted).toBe(false);

		expect(session.sendInput(ESCAPE)).toEqual({ consume: true });

		// `activePlaybackIndicator.stop()` routes to `abortActiveSpeak`: the synthesis is cancelled.
		expect(playback.signal?.aborted).toBe(true);
		playback.release();
		await speaking;
	});

	test("closing the panel without choosing a model leaves dictation refused", async () => {
		// The panel handler used to arm hold-to-talk whenever `config.enabled`, so closing the setup
		// panel after being told to pick a model armed a SPACE hold that would record on Parakeet. Now
		// the handler stays registered (F1/Escape need it) and only the SPACE branch refuses.
		const session = await runSessionStart({ onboarding: { completed: true } });

		await session.closePanel();

		expect(session.terminalInputSubscribed).toBe(true);
		expect(session.sendInput(SPACE_PRESS)).toBeUndefined();
		expect(session.widgetCalls.filter((call) => call.key === "voice-recording" && call.shown)).toEqual([]);
		// The status bar is left saying setup is still needed — not idle-and-ready.
		expect(session.statuses).toContainEqual(["voice", "MIC SETUP"]);
	});

	test("closing the panel without choosing a model leaves in-flight speech running", async () => {
		// The panel handler called `voiceCleanup()` when no model was configured: that cancels installs,
		// stops playback and drops every widget — far more than disarming dictation. Only dictation may
		// stop here; work the user started for another reason keeps its floor.
		const session = await runSessionStart(
			{ onboarding: { completed: true }, ttsEnabled: true },
			{
				ttsModelInstalled: true,
			}
		);
		const speaking = session.runSpeak("hello");
		await waitUntil(() => pendingPlayback !== undefined);
		const playback = takePlayback();

		await session.closePanel();

		expect(playback.signal?.aborted).toBe(false);
		expect(playback.settled).toBe(false);
		// ...and dictation really is the part that was disarmed: a hold is refused, nothing is shown.
		expect(session.sendInput(SPACE_PRESS)).toBeUndefined();
		// (The panel-close disarm hides the dictation widget; showing it would be the warm-up.)
		expect(session.widgetCalls.filter((call) => call.key === "voice-recording" && call.shown)).toEqual([]);
		// The status bar is left saying setup is still needed — not idle-and-ready.
		expect(session.statuses).toContainEqual(["voice", "MIC SETUP"]);

		playback.release();
		await speaking;
	});

	test("choosing a model in the panel arms dictation without a restart", async () => {
		const session = await runSessionStart({ onboarding: { completed: true } });

		// `activateModel` is the panel's own path: it mutates the shared config, saves, and the panel's
		// post-close sync decides whether to wire hold-to-talk.
		await session.closePanel((panel) => panel.activateModel("parakeet-v3"));

		expect(session.terminalInputSubscribed).toBe(true);
		expect(session.statuses).toContainEqual(["voice", "MIC LOCAL"]);
		expect(JSON.parse(fs.readFileSync(session.settingsPath, "utf8")).voice.localModel).toBe("parakeet-v3");
	});
});

describe("preview settings", () => {
	test("defaults, type validation and both save paths preserve preview fields", () => {
		const agentDir = makeTempDir();
		const cwd = makeTempDir();
		expect(loadConfigWithSource(cwd, { agentDir }).config.previewEnabled).toBe(true);
		expect(loadConfigWithSource(cwd, { agentDir }).config.localPreviewModel).toBe(
			"streaming-paraformer-bilingual-zh-en"
		);
		writeSettings(agentDir, "settings.json", { previewEnabled: "false", localPreviewModel: 42 });
		expect(loadConfigWithSource(cwd, { agentDir }).config.previewEnabled).toBe(true);
		expect(loadConfigWithSource(cwd, { agentDir }).config.localPreviewModel).toBe(
			"streaming-paraformer-bilingual-zh-en"
		);
		saveConfig({ ...DEFAULT_CONFIG, previewEnabled: false, localPreviewModel: "custom" }, "global", cwd, { agentDir });
		expect(loadConfigWithSource(cwd, { agentDir }).config.previewEnabled).toBe(false);
		expect(loadConfigWithSource(cwd, { agentDir }).config.localPreviewModel).toBe("custom");
		saveGlobalVoiceFields({ previewEnabled: true, localPreviewModel: "other" }, { agentDir });
		expect(loadConfigWithSource(cwd, { agentDir }).config.localPreviewModel).toBe("other");
		expect(loadConfigWithSource(cwd, { agentDir }).config.previewEnabled).toBe(true);
		saveConfig({ ...DEFAULT_CONFIG, previewEnabled: false, localPreviewModel: "project" }, "project", cwd, {
			agentDir,
		});
		expect(loadConfigWithSource(cwd, { agentDir }).config.previewEnabled).toBe(false);
		expect(loadConfigWithSource(cwd, { agentDir }).config.localPreviewModel).toBe("project");
	});
});

describe("maxRecordingSeconds (recording budget)", () => {
	test("maxRecordingSeconds defaults to 120 and survives both save paths", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");

		expect(DEFAULT_CONFIG.maxRecordingSeconds).toBe(120);

		// parse round-trip with an explicit override
		writeSettings(agentDir, "settings.json", { version: VOICE_CONFIG_VERSION, maxRecordingSeconds: 300 });
		expect(loadConfigWithSource(cwd, { agentDir }).config.maxRecordingSeconds).toBe(300);

		// a full save renders the field, so it survives a reload
		fs.rmSync(agentDir, { recursive: true, force: true });
		saveConfig({ ...DEFAULT_CONFIG, scope: "global", maxRecordingSeconds: 300 }, "global", cwd, { agentDir });
		expect(loadConfigWithSource(cwd, { agentDir }).config.maxRecordingSeconds).toBe(300);

		// the field-scoped global writer merges the key it is given
		const scopedAgentDir = path.join(cwd, "scoped-agent-home");
		saveGlobalVoiceFields({ maxRecordingSeconds: 300 }, { agentDir: scopedAgentDir });
		expect(loadConfigWithSource(cwd, { agentDir: scopedAgentDir }).config.maxRecordingSeconds).toBe(300);

		// a field-scoped save that does not name it must not create it
		const otherAgentDir = path.join(cwd, "other-agent-home");
		saveGlobalVoiceFields({ punctuationNoticeShown: true }, { agentDir: otherAgentDir });
		const saved = JSON.parse(fs.readFileSync(path.join(otherAgentDir, "settings.json"), "utf8")) as {
			voice: Record<string, unknown>;
		};
		expect(saved.voice.maxRecordingSeconds).toBeUndefined();
		expect(Object.keys(saved.voice).sort()).toEqual(["punctuationNoticeShown", "version"]);
	});

	test("rejects a non-positive or non-finite budget and falls back to 120", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		const settingsPath = path.join(agentDir, "settings.json");

		for (const invalid of [0, -5, "300", null, true]) {
			writeSettings(agentDir, "settings.json", { maxRecordingSeconds: invalid });
			expect(loadConfigWithSource(cwd, { agentDir }).config.maxRecordingSeconds).toBe(120);
		}

		// `JSON.parse` turns an overflowing literal into Infinity, which is not a usable budget.
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(settingsPath, '{"voice":{"maxRecordingSeconds":1e400}}');
		expect(loadConfigWithSource(cwd, { agentDir }).config.maxRecordingSeconds).toBe(120);
	});
});
