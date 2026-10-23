// tests/no-cloud-egress.test.ts
//
// Enforces the local-only product claim (spec §8.3). Each rule group is scoped to the files the
// task that added it owns, so the file is green after every task; the cross-cutting sweep from
// spec §8.3 lands in Task 7, once no file can name a retired identifier.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "extensions";
const scanner = new Bun.Transpiler({ loader: "ts" });

function listFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const full = join(dir, entry);
		return statSync(full).isDirectory() ? listFiles(full) : entry.endsWith(".ts") ? [full] : [];
	});
}

const SOURCES: Record<string, string> = Object.fromEntries(
	listFiles(ROOT).map((file) => [file, readFileSync(file, "utf8")])
);

function importedPackages(text: string): string[] {
	return scanner.scanImports(text).map((hit) => hit.path);
}

/** Files whose text matches `pattern`; `scope` narrows the rule to the files a task owns. */
function matching(pattern: RegExp, scope?: string[]): string[] {
	return Object.entries(SOURCES)
		.filter(([file, text]) => (!scope || scope.includes(file)) && pattern.test(text))
		.map(([file]) => file);
}

test("no module imports the ws package", () => {
	const importers = Object.entries(SOURCES)
		.filter(([, text]) => importedPackages(text).includes("ws"))
		.map(([file]) => file);
	expect(importers).toEqual([]);
});

test("the cloud TTS module file is gone", () => {
	expect(Object.keys(SOURCES).filter((file) => file.includes("tts-deepgram"))).toEqual([]);
});

test("speak.ts and the settings panel carry no cloud TTS dispatch", () => {
	expect(
		matching(/tts-deepgram|deepgramSpeak|DEEPGRAM_TTS_VOICES|WebSocket/, [
			"extensions/voice/speak.ts",
			"extensions/voice/settings-panel.ts",
		])
	).toEqual([]);
});

test("the settings panel names no Deepgram Aura voice", () => {
	expect(matching(/aura-[a-z]+-[a-z]{2}/, ["extensions/voice/settings-panel.ts"])).toEqual([]);
});

test("voice.ts registers no cloud TTS command or import", () => {
	expect(matching(/tts-deepgram|registerCommand\("voice-stream"/, ["extensions/voice.ts"])).toEqual([]);
});

test("the cloud STT module is gone", () => {
	expect(Object.keys(SOURCES).filter((file) => /voice\/deepgram\.ts$/.test(file))).toEqual([]);
});

test("voice.ts no longer holds a streaming session", () => {
	// Scanning the identifier, not the constructor literal: the removed TTS module built its socket
	// as `new (globalThis as any).WebSocket(...)`, which a literal scan would have missed.
	expect(
		matching(/WebSocket|StreamingSession|preRecording|startStreamingRecording|voice\/deepgram/, ["extensions/voice.ts"])
	).toEqual([]);
});

const DOWNLOAD_MODULES = new Set(["extensions/voice/model-download.ts", "extensions/voice/tts-local-models.ts"]);

test("fetch appears only in the two model-download modules", () => {
	const offenders = Object.entries(SOURCES)
		.filter(([file, text]) => /\bfetch\(/.test(text) && !DOWNLOAD_MODULES.has(file))
		.map(([file]) => file);
	expect(offenders).toEqual([]);
});

test("no module references the external-endpoint fallback", () => {
	expect(
		matching(/checkLocalServer|transcribeWithServer|promptServerEndpoint|config\.localEndpoint/, [
			"extensions/voice/local.ts",
			"extensions/voice/onboarding.ts",
			"extensions/voice.ts",
		])
	).toEqual([]);
});

test("the settings panel exposes no backend choice", () => {
	expect(
		matching(/config\.backend|ttsBackend|deepgramLanguages|resolveApiKey|localEndpoint/, [
			"extensions/voice/settings-panel.ts",
		])
	).toEqual([]);
});

test("onboarding offers no cloud path and no Nova-3 language table", () => {
	expect(
		matching(/DEEPGRAM|dpgr\.am|LANGUAGES|modelForLanguage|VoiceBackend/, ["extensions/voice/onboarding.ts"])
	).toEqual([]);
});

test("voice.ts no longer imports the Nova-3 language table", () => {
	// `voice.ts` legitimately imports other symbols from `./voice/onboarding` (pickLanguage,
	// languageDisplayName, runVoiceOnboarding, …), so the rule names only the two symbols that die.
	expect(matching(/LANGUAGES|modelForLanguage/, ["extensions/voice.ts"])).toEqual([]);
});

// ─── Task 6: startup activation and operator-facing copy ─────────────────────

test("voice.ts carries no cloud copy left", () => {
	expect(matching(/DEEPGRAM|Deepgram|cloud/i, ["extensions/voice.ts"])).toEqual([]);
});

test("the sherpa messages name a platform, never a cloud fallback", () => {
	expect(
		matching(/deepgram|cloud backend/i, ["extensions/voice/sherpa-loader.ts", "extensions/voice/local.ts"])
	).toEqual([]);
	expect(SOURCES["extensions/voice/sherpa-loader.ts"]).toMatch(/win32[\s\S]{0,80}arm64/);
});
