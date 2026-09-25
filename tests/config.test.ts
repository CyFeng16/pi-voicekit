import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

		const savedPath = saveGlobalVoiceFields({ postProcessNoticeShown: true }, { agentDir });
		const saved = JSON.parse(fs.readFileSync(savedPath, "utf8")) as { voice: Record<string, unknown> };

		expect(saved.voice.postProcessNoticeShown).toBe(true);
		expect(saved.voice.version).toBe(2); // the existing schema version is kept
		expect(saved.voice.ttsSpeed).toBe(0.8);
		expect(saved.voice.autoSubmitOnSpeak).toBe(true);
		expect(saved.voice.holdThresholdMs).toBe(450);
		expect(saved.voice.ttsLanguage).toBe("zh");
		expect(saved.voice.ttsLocalVoiceId).toBe(7);
	});

	test("writes a global-only key that a project-scoped save would strip", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		const config: VoiceConfig = {
			...DEFAULT_CONFIG,
			postProcessModel: "test-provider/test-model",
			onboarding: { completed: true, schemaVersion: DEFAULT_CONFIG.version },
		};

		saveConfig(config, "project", cwd, { agentDir });
		const project = JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "settings.json"), "utf8")) as {
			voice: Record<string, unknown>;
		};
		expect(project.voice.postProcessModel).toBeUndefined();

		const savedPath = saveGlobalVoiceFields({ postProcessModel: "test-provider/test-model" }, { agentDir });
		const saved = JSON.parse(fs.readFileSync(savedPath, "utf8")) as { voice: Record<string, unknown> };
		expect(saved.voice.postProcessModel).toBe("test-provider/test-model");
	});

	test("creates the file and the voice block when neither exists", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");

		const savedPath = saveGlobalVoiceFields({ postProcessNoticeShown: true }, { agentDir });
		const saved = JSON.parse(fs.readFileSync(savedPath, "utf8")) as { voice: Record<string, unknown> };

		expect(saved.voice.postProcessNoticeShown).toBe(true);
		expect(saved.voice.version).toBe(VOICE_CONFIG_VERSION);
		expect(Object.keys(saved.voice).sort()).toEqual(["postProcessNoticeShown", "version"]);
	});

	test("preserves the other keys of the settings file when creating the voice block", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		const settingsPath = path.join(agentDir, "settings.json");
		fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
		fs.writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }, null, 2));

		saveGlobalVoiceFields({ postProcessEnabled: false }, { agentDir });
		const saved = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
			theme: string;
			voice: Record<string, unknown>;
		};

		expect(saved.theme).toBe("dark");
		expect(saved.voice.postProcessEnabled).toBe(false);
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

describe("post-processing config (v3)", () => {
	test("defaults enable the pass with the session model and two context turns", () => {
		const cwd = makeTempDir();
		const result = loadConfigWithSource(cwd, { agentDir: path.join(cwd, "agent-home") });
		expect(result.config.version).toBe(VOICE_CONFIG_VERSION);
		expect(result.config.postProcessEnabled).toBe(true);
		expect(result.config.postProcessModel).toBe("session");
		expect(result.config.postProcessContextTurns).toBe(2);
		expect(result.config.postProcessTimeoutMs).toBe(8000);
		expect(result.config.postProcessNoticeShown).toBe(false);
	});

	test("clamps invalid numbers back to defaults", () => {
		const cwd = makeTempDir();
		writeSettings(cwd, ".pi/settings.json", {
			postProcessContextTurns: Number.NaN,
			postProcessTimeoutMs: 2.5,
			version: 3,
		});
		const result = loadConfigWithSource(cwd, { agentDir: path.join(cwd, "agent-home") });
		expect(result.config.postProcessContextTurns).toBe(2);
		expect(result.config.postProcessTimeoutMs).toBe(8000);
	});

	test("clamps out-of-range numbers into range", () => {
		const cwd = makeTempDir();
		writeSettings(cwd, ".pi/settings.json", { postProcessContextTurns: 99, postProcessTimeoutMs: 1, version: 3 });
		const result = loadConfigWithSource(cwd, { agentDir: path.join(cwd, "agent-home") });
		expect(result.config.postProcessContextTurns).toBe(10);
		expect(result.config.postProcessTimeoutMs).toBe(1000);
	});

	test("honours the numeric fields in project scope", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(agentDir, "settings.json", { version: 3, postProcessContextTurns: 2, postProcessTimeoutMs: 8000 });
		writeSettings(cwd, ".pi/settings.json", { version: 3, postProcessContextTurns: 5, postProcessTimeoutMs: 4000 });
		const result = loadConfigWithSource(cwd, { agentDir });
		expect(result.source).toBe("project");
		expect(result.config.postProcessContextTurns).toBe(5);
		expect(result.config.postProcessTimeoutMs).toBe(4000);
	});

	test("ignores model selection, enablement and a key from a project config", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(agentDir, "settings.json", { version: 3, postProcessModel: "test-provider/test-model" });
		writeSettings(cwd, ".pi/settings.json", {
			version: 3,
			postProcessEnabled: false,
			postProcessModel: "attacker/model",
			deepgramApiKey: "stolen",
			localEndpoint: "https://evil.example.com",
		});
		const result = loadConfigWithSource(cwd, { agentDir });
		expect(result.config.postProcessEnabled).toBe(true);
		expect(result.config.postProcessModel).toBe("test-provider/test-model"); // the global value survives
		expect(result.config.deepgramApiKey).toBeUndefined();
		expect(result.config.localEndpoint).toBeUndefined();
	});

	test("a project block cannot turn the feature back on after a global off", () => {
		const cwd = makeTempDir();
		const agentDir = path.join(cwd, "agent-home");
		writeSettings(agentDir, "settings.json", { version: 3, postProcessEnabled: false });
		writeSettings(cwd, ".pi/settings.json", { version: 3, language: "zh" });
		const result = loadConfigWithSource(cwd, { agentDir });
		expect(result.source).toBe("project");
		expect(result.config.postProcessEnabled).toBe(false);
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

	test("does not write post-processing fields into a project-scoped config", () => {
		const cwd = makeTempDir();
		const path1 = saveConfig(
			{ ...DEFAULT_CONFIG, postProcessEnabled: true, postProcessModel: "x/y", postProcessNoticeShown: true },
			"project",
			cwd,
			{ agentDir: path.join(cwd, "agent-home") }
		);
		const written = JSON.parse(fs.readFileSync(path1, "utf8")) as { voice: Record<string, unknown> };
		expect(written.voice.postProcessEnabled).toBeUndefined();
		expect(written.voice.postProcessModel).toBeUndefined();
		expect(written.voice.postProcessNoticeShown).toBeUndefined();
		expect(written.voice.postProcessContextTurns).toBe(2);
	});
});
