import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import voiceExtension, { safeErrorText } from "../extensions/voice";
import { resetPunctuationForTest } from "../extensions/voice/punctuation";
import {
	DEFAULT_CONFIG,
	loadConfigWithSource,
	needsOnboarding,
	saveConfig,
	saveGlobalVoiceFields,
	scrubRetiredVoiceKeys,
	VOICE_CONFIG_VERSION,
	type VoiceConfig,
} from "../extensions/voice/config";

const tempDirs: string[] = [];

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

afterEach(() => {
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
		// secret value nor the host may reach the notice.
		expect(result.message).toContain("deepgramApiKey");
		expect(result.message).toContain("localEndpoint");
		expect(result.message).toContain("DEEPGRAM_API_KEY");
		expect(result.message).toContain("0.6.0");
		expect(result.message).toContain("~/.env.secrets");
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
		expect(() => saveGlobalVoiceFields({ punctuationEnabled: false }, { agentDir })).toThrow(/unread|refus/i);
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
		readonly holdToTalkSubscribed: boolean;
		joinedNotices(): string;
	}

	async function runSessionStart(
		voice: unknown,
		options: { projectVoice?: unknown; corruptGlobalSettings?: boolean } = {}
	): Promise<SessionHarness> {
		const home = makeTempDir();
		const cwd = makeTempDir();
		if (options.corruptGlobalSettings) {
			// A file that exists but cannot be parsed — the one shape the scrub refuses to rewrite.
			const settingsPath = path.join(home, ".pi", "agent", "settings.json");
			fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
			fs.writeFileSync(settingsPath, "{ not json");
		} else {
			writeSettings(home, ".pi/agent/settings.json", voice);
		}
		if (options.projectVoice !== undefined) writeSettings(cwd, ".pi/settings.json", options.projectVoice);

		const homeSpy = spyOn(os, "homedir").mockReturnValue(home);
		resetPunctuationForTest(null, () => {});
		try {
			const handlers = new Map<string, (event: any, sessionCtx: any) => Promise<void>>();
			const pi = {
				on: (name: string, handler: any) => handlers.set(name, handler),
				registerShortcut: () => {},
				registerCommand: () => {},
			} as any;

			const notices: Array<[string, string]> = [];
			const statuses: Array<[string, string | undefined]> = [];
			let holdToTalkSubscribed = false;
			const sessionCtx = {
				hasUI: true,
				cwd,
				ui: {
					notify: (message: string, type: string) => notices.push([message, type]),
					setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
					onTerminalInput: () => {
						holdToTalkSubscribed = true;
						return () => {};
					},
				},
			};

			voiceExtension(pi);
			const sessionStart = handlers.get("session_start");
			expect(sessionStart).toBeDefined();
			await sessionStart!({ reason: "startup" }, sessionCtx);

			return {
				notices,
				statuses,
				get holdToTalkSubscribed() {
					return holdToTalkSubscribed;
				},
				joinedNotices: () => notices.map(([message]) => message).join("\n"),
			};
		} finally {
			resetPunctuationForTest();
			homeSpy.mockRestore();
		}
	}

	test("a local model alone auto-activates hold-to-talk", async () => {
		const session = await runSessionStart({
			onboarding: { completed: true },
			localModel: "paraformer-zh",
			language: "zh",
		});

		// The completed branch keeps its historical silence (brief step 3: "behave as today"), so the
		// observable activation is the hold-to-talk subscription plus the LOCAL status entry. What
		// must not appear anywhere is a cloud backend name.
		expect(session.holdToTalkSubscribed).toBe(true);
		expect(session.statuses).toContainEqual(["voice", "MIC LOCAL"]);
		expect(session.joinedNotices()).not.toMatch(/deepgram|cloud|nova-3/i);
	});

	test("a local model without completed onboarding is migrated and activated", async () => {
		// The panel writes `localModel` and never writes `backend` any more; the activation predicate
		// must key on the model alone or the settings write succeeds and nothing ever activates.
		const session = await runSessionStart({ localModel: "paraformer-zh", language: "zh" });

		expect(session.holdToTalkSubscribed).toBe(true);
		expect(session.joinedNotices()).toContain("Paraformer zh (bilingual)");
	});

	test("a completed config with no local model is sent to setup, not silently defaulted", async () => {
		// The shape every Deepgram user has after the upgrade: onboarding completed, no localModel.
		// "Completed" is not "configured" — the branch must not wire hold-to-talk onto a default.
		const session = await runSessionStart({ onboarding: { completed: true }, backend: "deepgram" });

		expect(session.joinedNotices()).toContain("/voice-setup");
		expect(session.holdToTalkSubscribed).toBe(false);
		expect(session.joinedNotices()).not.toMatch(/deepgram|cloud|nova-3/i);
	});

	test("no local model sends the user to setup instead of a dead backend", async () => {
		const session = await runSessionStart({});

		// The install hint is the only remaining entry point: one path, and it names the command that
		// opens the settings panel.
		expect(session.joinedNotices()).toContain("pi-voicekit installed");
		expect(session.joinedNotices()).toContain("/voice-setup");
		expect(session.joinedNotices()).not.toMatch(/deepgram|cloud|nova-3|two backends/i);
		expect(session.holdToTalkSubscribed).toBe(false);
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

		expect(session.holdToTalkSubscribed).toBe(true);
		const warnings = session.notices.filter(([, type]) => type === "warning");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]![0]).toMatch(/settings file/i);
		expect(warnings[0]![0]).toMatch(/still on disk/i);
	});
});
