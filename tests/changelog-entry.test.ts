// tests/changelog-entry.test.ts
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { extractEntry, normalizeVersion } from "../scripts/changelog-entry.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURE = [
	"# Changelog",
	"",
	"## [Unreleased]",
	"",
	"### Changed",
	"",
	"- unreleased work",
	"",
	"## [0.1.30] - 2026-01-01",
	"",
	"- thirty",
	"",
	"## [0.1.3] - 2026-01-02",
	"",
	"### Fixed",
	"",
	"- three",
	"",
	"## [0.1.3] - 2026-01-03",
	"",
	"- duplicate three",
	"",
	"## [0.1.2] - 2026-01-04",
	"",
	"## [3.0.0] - 2020-01-01",
	"",
	"- ancient",
	"",
	"[0.1.3]: https://example.test/compare/v0.1.2...v0.1.3",
	"[3.0.0]: https://example.test/releases/tag/v3.0.0",
	"",
].join("\n");

test("normalises the accepted spellings to a bare version", () => {
	expect(normalizeVersion("0.1.3")).toBe("0.1.3");
	expect(normalizeVersion("v0.1.3")).toBe("0.1.3");
	expect(normalizeVersion("[0.1.3]")).toBe("0.1.3");
	expect(normalizeVersion("Unreleased")).toBe("Unreleased");
	expect(normalizeVersion("[Unreleased]")).toBe("Unreleased");
});

test("returns the body of a version without its heading", () => {
	const result = extractEntry(FIXTURE, "0.1.3");
	expect(result.status).toBe("ok");
	expect(result).toEqual({ status: "ok", body: "### Fixed\n\n- three\n" });
});

test("stops at the next h2 and keeps h3 subsections", () => {
	const result = extractEntry(FIXTURE, "Unreleased");
	expect(result).toEqual({ status: "ok", body: "### Changed\n\n- unreleased work\n" });
});

test("strips a trailing link-definition block", () => {
	const result = extractEntry(FIXTURE, "3.0.0");
	expect(result).toEqual({ status: "ok", body: "- ancient\n" });
});

test("reports a missing version", () => {
	expect(extractEntry(FIXTURE, "9.9.9")).toEqual({ status: "missing" });
});

test("reports a present but empty section", () => {
	expect(extractEntry(FIXTURE, "0.1.2")).toEqual({ status: "empty" });
});

test("does not match a longer version that shares a prefix", () => {
	expect(extractEntry(FIXTURE, "0.1.30")).toEqual({ status: "ok", body: "- thirty\n" });
	const wanted = extractEntry(FIXTURE, "0.1.3");
	expect(wanted.status === "ok" && wanted.body.includes("thirty")).toBe(false);
});

test("first match wins when a version appears twice", () => {
	const result = extractEntry(FIXTURE, "0.1.3");
	expect(result.status === "ok" && result.body.includes("duplicate three")).toBe(false);
});

test("tolerates CRLF and a missing trailing newline", () => {
	expect(extractEntry("## [0.2.0] - x\r\n\r\n- crlf\r\n", "0.2.0")).toEqual({
		status: "ok",
		body: "- crlf\n",
	});
	expect(extractEntry("## [0.3.0] - x\n\n- no newline", "0.3.0")).toEqual({
		status: "ok",
		body: "- no newline\n",
	});
});

test("accepts the v-prefixed and bracketed spellings", () => {
	expect(extractEntry(FIXTURE, "v0.1.3")).toEqual(extractEntry(FIXTURE, "[0.1.3]"));
});

test("returns the body for every version the real CHANGELOG.md actually contains", () => {
	const markdown = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
	const versions = [...markdown.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1]);
	expect(versions).toContain("0.1.3");
	for (const version of versions) {
		const result = extractEntry(markdown, version);
		expect(result.status).not.toBe("missing");
		// `[Unreleased]` is legitimately empty between releases — the release commit
		// empties it. A shipped version never is, and the workflow gates on exactly
		// that: an empty section must not be allowed to pass the suite.
		if (version !== "Unreleased") expect(result.status).toBe("ok");
	}
});

// --- CLI contract: these exit codes are the workflow's fail-fast mechanism ---

const SCRIPT = fileURLToPath(new URL("../scripts/changelog-entry.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const run = (...cliArgs: string[]) => spawnSync("node", [SCRIPT, ...cliArgs], { cwd: REPO_ROOT, encoding: "utf8" });

test("exits 2 with no version, an unknown option, an extra argument, or a bare --file", () => {
	const bare = run();
	expect(bare.status).toBe(2);
	expect(bare.stderr).toContain("usage:");
	expect(bare.stdout).toBe("");
	expect(run("0.1.3", "--nope").status).toBe(2);
	expect(run("0.1.3", "extra").status).toBe(2);
	expect(run("0.1.3", "--file").status).toBe(2);
});

test("exits 2 on an unrecognized version spelling", () => {
	const result = run("latest");
	expect(result.status).toBe(2);
	expect(result.stderr).toContain("unrecognized version spelling");
});

test("exits 1 when the section is missing, naming the version", () => {
	const result = run("9.9.9");
	expect(result.status).toBe(1);
	expect(result.stderr).toContain("no section for 9.9.9");
	expect(result.stdout).toBe("");
});

test("exits 2 for an unreadable file, 0 with only the body on stdout for a real one", () => {
	expect(run("0.1.3", "--file", "nope.md").status).toBe(2);

	const ok = run("0.1.3");
	expect(ok.status).toBe(0);
	expect(ok.stderr).toBe("");
	const expected = extractEntry(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"), "0.1.3");
	if (expected.status !== "ok") throw new Error("fixture assumption: CHANGELOG.md has a 0.1.3 section");
	expect(ok.stdout).toBe(expected.body);
	expect(ok.stdout.startsWith("## ")).toBe(false);
});
