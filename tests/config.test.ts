import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import voiceExtension, { safeErrorText } from "../extensions/voice";
import {
	DEFAULT_CONFIG,
	getSessionStartPersistedConfig,
	isLoopbackEndpoint,
	loadConfigWithSource,
	needsOnboarding,
	saveConfig,
	saveGlobalVoiceFields,
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

	test("migrates legacy global config and marks onboarding complete when backend and model were explicit", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		// Legacy config had backend + model fields — migration still recognizes them
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
	test("does not persist an env-only Deepgram key during session-start saves", () => {
		const persisted = getSessionStartPersistedConfig({
			config: {
				...DEFAULT_CONFIG,
				scope: "global",
				onboarding: {
					completed: true,
					schemaVersion: DEFAULT_CONFIG.version,
				},
			},
			envDeepgramApiKey: "env-secret-123",
		});

		expect(persisted.deepgramApiKey).toBeUndefined();
	});

	test("preserves an explicitly stored Deepgram key during session-start saves", () => {
		const persisted = getSessionStartPersistedConfig({
			config: {
				...DEFAULT_CONFIG,
				scope: "global",
				deepgramApiKey: "saved-secret-123",
				onboarding: {
					completed: true,
					schemaVersion: DEFAULT_CONFIG.version,
				},
			},
			envDeepgramApiKey: "env-secret-123",
		});

		expect(persisted.deepgramApiKey).toBe("saved-secret-123");
	});

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

	test("strips deepgramApiKey from project-scoped saves", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		const config: VoiceConfig = {
			...DEFAULT_CONFIG,
			scope: "project",
			deepgramApiKey: "secret-key-abc123",
			onboarding: { completed: true, schemaVersion: DEFAULT_CONFIG.version },
		};

		const savedPath = saveConfig(config, "project", cwd, { agentDir });
		const saved = JSON.parse(fs.readFileSync(savedPath, "utf8"));

		expect(saved.voice.deepgramApiKey).toBeUndefined();
	});

	test("preserves deepgramApiKey in global-scoped saves", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		const config: VoiceConfig = {
			...DEFAULT_CONFIG,
			scope: "global",
			deepgramApiKey: "secret-key-abc123",
			onboarding: { completed: true, schemaVersion: DEFAULT_CONFIG.version },
		};

		const savedPath = saveConfig(config, "global", cwd, { agentDir });
		const saved = JSON.parse(fs.readFileSync(savedPath, "utf8"));

		expect(saved.voice.deepgramApiKey).toBe("secret-key-abc123");
	});

	test("strips non-loopback localEndpoint from project-scoped saves", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		const config: VoiceConfig = {
			...DEFAULT_CONFIG,
			scope: "project",
			localEndpoint: "http://evil.com:8080",
			onboarding: { completed: true, schemaVersion: DEFAULT_CONFIG.version },
		};

		const savedPath = saveConfig(config, "project", cwd, { agentDir });
		const saved = JSON.parse(fs.readFileSync(savedPath, "utf8"));

		expect(saved.voice.localEndpoint).toBeUndefined();
	});

	test("preserves loopback localEndpoint in project-scoped saves", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		const config: VoiceConfig = {
			...DEFAULT_CONFIG,
			scope: "project",
			localEndpoint: "http://localhost:8080",
			onboarding: { completed: true, schemaVersion: DEFAULT_CONFIG.version },
		};

		const savedPath = saveConfig(config, "project", cwd, { agentDir });
		const saved = JSON.parse(fs.readFileSync(savedPath, "utf8"));

		expect(saved.voice.localEndpoint).toBe("http://localhost:8080");
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

describe("punctuation config (scope-agnostic, default true)", () => {
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

	test("a project block overrides the global value", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(agentDir, "settings.json", { version: 3, punctuationEnabled: false });
		writeSettings(cwd, ".pi/settings.json", { version: 3, punctuationEnabled: true });

		const result = loadConfigWithSource(cwd, { agentDir });
		expect(result.source).toBe("project");
		expect(result.config.punctuationEnabled).toBe(true);
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

describe("isLoopbackEndpoint", () => {
	test("accepts localhost", () => {
		expect(isLoopbackEndpoint("http://localhost:8080")).toBe(true);
	});

	test("accepts 127.0.0.1", () => {
		expect(isLoopbackEndpoint("http://127.0.0.1:9090")).toBe(true);
	});

	test("accepts ::1", () => {
		expect(isLoopbackEndpoint("http://[::1]:8080")).toBe(true);
	});

	test("accepts https localhost", () => {
		expect(isLoopbackEndpoint("https://localhost:8443")).toBe(true);
	});

	test("rejects remote hosts", () => {
		expect(isLoopbackEndpoint("http://evil.com:8080")).toBe(false);
	});

	test("rejects private IPs", () => {
		expect(isLoopbackEndpoint("http://192.168.1.1:8080")).toBe(false);
	});

	test("rejects non-http protocols", () => {
		expect(isLoopbackEndpoint("ftp://localhost:21")).toBe(false);
		expect(isLoopbackEndpoint("file://localhost/etc/passwd")).toBe(false);
	});

	test("rejects invalid URLs", () => {
		expect(isLoopbackEndpoint("not-a-url")).toBe(false);
		expect(isLoopbackEndpoint("")).toBe(false);
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
			// Scope-agnostic switch: the project value wins over the global one.
			punctuationEnabled: true,
			// Global-only flag: a project file must not be able to silence the notice.
			punctuationNoticeShown: false,
		});

		const result = loadConfigWithSource(cwd, { agentDir });

		expect(result.source).toBe("project");
		expect(result.config.version).toBe(VOICE_CONFIG_VERSION);
		expect(result.config.punctuationEnabled).toBe(true);
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

	test("ignores an API key and a non-loopback endpoint from a project config", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(agentDir, "settings.json", { version: 3, deepgramApiKey: "saved-secret-123" });
		writeSettings(cwd, ".pi/settings.json", {
			version: 3,
			deepgramApiKey: "stolen",
			localEndpoint: "https://evil.example.com",
		});
		const result = loadConfigWithSource(cwd, { agentDir });
		expect(result.config.deepgramApiKey).toBe("saved-secret-123"); // the global value survives
		expect(result.config.localEndpoint).toBeUndefined();
	});

	test("keeps a project loopback endpoint but falls back to the global one for a non-loopback value", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(agentDir, "settings.json", { version: 3, localEndpoint: "http://127.0.0.1:9999" });
		writeSettings(cwd, ".pi/settings.json", { version: 3, language: "zh", localEndpoint: "http://10.0.0.5:8080" });
		expect(loadConfigWithSource(cwd, { agentDir }).config.localEndpoint).toBe("http://127.0.0.1:9999");
		writeSettings(cwd, ".pi/settings.json", { version: 3, language: "zh", localEndpoint: "http://127.0.0.1:8080" });
		expect(loadConfigWithSource(cwd, { agentDir }).config.localEndpoint).toBe("http://127.0.0.1:8080");
	});

	test("still accepts a loopback local endpoint from a project config", () => {
		const cwd = makeTempDir();
		writeSettings(cwd, ".pi/settings.json", { version: 3, localEndpoint: "http://127.0.0.1:8080" });
		const result = loadConfigWithSource(cwd, { agentDir: path.join(cwd, "agent-home") });
		expect(result.config.localEndpoint).toBe("http://127.0.0.1:8080");
	});

	test("does not report a honoured loopback project endpoint as ignored", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(agentDir, "settings.json", { version: 3 });
		writeSettings(cwd, ".pi/settings.json", { version: 3, localEndpoint: "http://127.0.0.1:8080" });

		const chunks: string[] = [];
		const original = process.stderr.write;
		process.stderr.write = ((chunk: string | Uint8Array) => {
			chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
			return true;
		}) as typeof process.stderr.write;
		try {
			const result = loadConfigWithSource(cwd, { agentDir });
			expect(result.config.localEndpoint).toBe("http://127.0.0.1:8080");
		} finally {
			process.stderr.write = original;
		}

		expect(chunks.join("")).not.toContain("localEndpoint");
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
