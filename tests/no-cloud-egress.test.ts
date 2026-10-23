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
