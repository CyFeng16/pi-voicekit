import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "extensions";

function listFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const full = join(dir, entry);
		return statSync(full).isDirectory() ? listFiles(full) : entry.endsWith(".ts") ? [full] : [];
	});
}

test("no module hands a dictation to the agent", () => {
	const offenders = listFiles(ROOT).filter((file) => readFileSync(file, "utf8").includes("sendUserMessage"));
	expect(offenders).toEqual([]);
});
