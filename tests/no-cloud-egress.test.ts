// tests/no-cloud-egress.test.ts
//
// Enforces the local-only product claim (spec §8.3). The rules a task added are scoped to the files
// that task owns; the final group is the cross-cutting sweep, which lands once no file can name a
// retired identifier.
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

/**
 * Aura ids are `aura-<name>-<lang>`, and Aura-2 inserts the generation: `aura-2-thalia-en`, which is
 * the shape the removed backend documented and a user could paste into `ttsDeepgramVoiceId`. The
 * optional group is the point — a pattern that only matched Aura-1 would pass this file while a
 * reintroduced Aura-2 voice sat in the settings panel undetected.
 */
const AURA_VOICE_ID = /aura-(?:\d+-)?[a-z]+-[a-z]{2}/;

test("the Aura voice-id pattern matches the identifiers the removed backend used", () => {
	expect(AURA_VOICE_ID.test("aura-2-thalia-en")).toBe(true);
	expect(AURA_VOICE_ID.test("aura-asteria-en")).toBe(true);
	expect(AURA_VOICE_ID.test("aurelia")).toBe(false);
});

test("the settings panel names no Deepgram Aura voice", () => {
	expect(matching(AURA_VOICE_ID, ["extensions/voice/settings-panel.ts"])).toEqual([]);
});

test("voice.ts registers no cloud TTS command or import", () => {
	expect(matching(/tts-deepgram|registerCommand\("voice-stream"/, ["extensions/voice.ts"])).toEqual([]);
});

test("the cloud STT module is gone", () => {
	expect(Object.keys(SOURCES).filter((file) => /voice\/deepgram\.ts$/.test(file))).toEqual([]);
});

test("voice.ts no longer holds a streaming session", () => {
	// Scanning the identifier, not the constructor literal: a socket can be built as
	// `new (globalThis as any).WebSocket(...)`, which a literal scan would have missed.
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

// ─── Task 7: cross-cutting sweep (spec §8.3) ─────────────────────────────────

/**
 * The retired names that may appear in exactly one file, and why: Task 8's startup scrub spells
 * `deepgramApiKey`, `localEndpoint` and `DEEPGRAM_API_KEY` to erase them from settings.json, so it
 * cannot exist without naming them. `config.backend`, `ttsBackend` and every other retired
 * identifier get no exemption — a survivor here is a field that was never actually deleted.
 */
const EXEMPT_FILE = "extensions/voice/config.ts";
const EXEMPT_IDENTIFIERS: Record<string, readonly string[]> = {
	[EXEMPT_FILE]: ["deepgramApiKey", "localEndpoint", "DEEPGRAM_API_KEY"],
};

const RETIRED_IDENTIFIERS = [
	"DEEPGRAM_API_KEY",
	"deepgramApiKey",
	"ttsDeepgram",
	"ttsDeepgramVoiceId",
	"VoiceBackend",
	"localEndpoint",
	"DEFAULT_LOCAL_ENDPOINT",
	"StreamingSession",
	"transcribeWithServer",
	"checkLocalServer",
	"config.backend",
	"ttsBackend",
];

test("no module names a retired identifier outside the exempt file", () => {
	const offenders = Object.entries(SOURCES)
		.filter(([file, text]) =>
			RETIRED_IDENTIFIERS.some((needle) => text.includes(needle) && !(EXEMPT_IDENTIFIERS[file] ?? []).includes(needle))
		)
		.map(([file]) => file);
	expect(offenders).toEqual([]);
});

test("no module names the WebSocket API or a retired vendor host", () => {
	expect(matching(/WebSocket|api\.deepgram\.com|developers\.deepgram\.com|dpgr\.am/)).toEqual([]);
});

test("no module mentions the retired vendor by name, in any casing", () => {
	// The scoped rules kept going blind to prose ("Deepgram — cloud, live streaming"), so this one
	// covers the whole tree. `config.ts` is exempt because Task 8's scrub message names the vendor.
	const offenders = Object.entries(SOURCES)
		.filter(([file, text]) => /deepgram/i.test(text) && file !== EXEMPT_FILE)
		.map(([file]) => file);
	expect(offenders).toEqual([]);
});
