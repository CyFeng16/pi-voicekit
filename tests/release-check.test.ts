// tests/release-check.test.ts
//
// The release contract of spec §6.1, exercised on strings only: no case here reads the
// repository's own package.json, package-lock.json or CHANGELOG.md.
import { describe, expect, test } from "bun:test";
import { checkRelease, type ReleaseFiles } from "../scripts/release-check.mjs";

const VERSION = "0.6.5";
const REPO = "https://github.com/CyFeng16/pi-voicekit";

function manifest(version = VERSION): string {
	return `${JSON.stringify({ name: "pi-voicekit", version }, null, 2)}\n`;
}

function lockFile(overrides: { version?: string; rootVersion?: string } = {}): string {
	const document = {
		name: "pi-voicekit",
		version: overrides.version ?? VERSION,
		lockfileVersion: 3,
		packages: { "": { name: "pi-voicekit", version: overrides.rootVersion ?? VERSION } },
	};
	return `${JSON.stringify(document, null, 2)}\n`;
}

const CHANGELOG = [
	"# Changelog",
	"",
	"## [Unreleased]",
	"",
	"## [0.6.5] - 2026-10-25",
	"",
	"### Fixed",
	"",
	"- a fixed thing",
	"",
	`[Unreleased]: ${REPO}/compare/v0.6.5...HEAD`,
	`[0.6.5]: ${REPO}/compare/v0.6.4...v0.6.5`,
	"",
].join("\n");

/** A release that satisfies all four rules, with the files a test wants broken. */
function release(overrides: Partial<ReleaseFiles> = {}): ReleaseFiles {
	return { packageJson: manifest(), packageLock: lockFile(), changelog: CHANGELOG, ...overrides };
}

describe("checkRelease — spec §6.1", () => {
	test("passes on a complete release", () => {
		expect(checkRelease(release(), VERSION)).toEqual([]);
	});

	test("fails when package.json version differs", () => {
		const violations = checkRelease(release({ packageJson: manifest("0.6.4") }), VERSION);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain("package.json");
		expect(violations[0]).toContain("0.6.4");
	});

	test("fails when the lockfile root version differs", () => {
		const violations = checkRelease(release({ packageLock: lockFile({ version: "0.6.4" }) }), VERSION);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain("package-lock.json");
		// The message names the exact field, so a release knows which of the two to fix.
		expect(violations[0]).not.toContain('packages[""]');
		expect(violations[0]).toContain("0.6.4");
	});

	test('fails when packages[""].version differs', () => {
		const violations = checkRelease(release({ packageLock: lockFile({ rootVersion: "0.6.4" }) }), VERSION);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain("package-lock.json");
		expect(violations[0]).toContain('packages[""].version');
		expect(violations[0]).toContain("0.6.4");
	});

	test("fails when the changelog has no section for the version", () => {
		// Every other rule holds: only the `## [0.6.5]` section itself is absent.
		const changelog = [
			"# Changelog",
			"",
			"## [Unreleased]",
			"",
			"## [0.6.4] - 2026-10-20",
			"",
			"- an older release",
			"",
			`[Unreleased]: ${REPO}/compare/v0.6.5...HEAD`,
			`[0.6.5]: ${REPO}/compare/v0.6.4...v0.6.5`,
			"",
		].join("\n");
		const violations = checkRelease(release({ changelog }), VERSION);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain("CHANGELOG.md");
		expect(violations[0]).toContain("0.6.5");
	});

	test("fails when the version heading carries no date", () => {
		const violations = checkRelease(
			release({ changelog: CHANGELOG.replace("## [0.6.5] - 2026-10-25", "## [0.6.5]") }),
			VERSION
		);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain("YYYY-MM-DD");
	});

	test("fails when [Unreleased] is not empty", () => {
		const changelog = CHANGELOG.replace("## [Unreleased]\n", "## [Unreleased]\n\n- work in progress\n");
		const violations = checkRelease(release({ changelog }), VERSION);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain("[Unreleased]");
		expect(violations[0]).toContain("not empty");
	});

	test("passes when [Unreleased] holds only headings and blank lines", () => {
		const changelog = CHANGELOG.replace("## [Unreleased]\n", "## [Unreleased]\n\n### Added\n\n### Fixed\n");
		expect(checkRelease(release({ changelog }), VERSION)).toEqual([]);
	});

	test("fails when there is no [Unreleased] section", () => {
		const violations = checkRelease(release({ changelog: CHANGELOG.replace("## [Unreleased]\n", "") }), VERSION);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain("[Unreleased]");
	});

	test("fails when the compare link for the version is missing", () => {
		const changelog = CHANGELOG.replace(`[0.6.5]: ${REPO}/compare/v0.6.4...v0.6.5\n`, "");
		const violations = checkRelease(release({ changelog }), VERSION);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain("[0.6.5]:");
	});

	test("fails when [Unreleased] does not point at the release", () => {
		const changelog = CHANGELOG.replace(
			`[Unreleased]: ${REPO}/compare/v0.6.5...HEAD`,
			`[Unreleased]: ${REPO}/compare/v0.6.4...HEAD`
		);
		const violations = checkRelease(release({ changelog }), VERSION);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain("[Unreleased]:");
		expect(violations[0]).toContain("0.6.5");
	});

	test("fails closed when package.json is not valid JSON", () => {
		const violations = checkRelease(release({ packageJson: "{ version: 0.6.5" }), VERSION);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain("package.json");
		expect(violations[0]).toContain("not valid JSON");
	});
});
