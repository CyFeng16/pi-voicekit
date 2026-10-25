#!/usr/bin/env node
// scripts/release-check.mjs
//
// The four rules CONTRIBUTING.md asks of the commit a release tag points at, checked as
// one unit (spec §6.1). A checker only: it publishes nothing, tags nothing, edits nothing,
// and does not judge the wording of the release notes.
//
// `package.json` -> `files` is an allow-list that does not include `scripts/`, so this never
// ships to npm consumers. It imports only Node built-ins and a sibling `.mjs`, so both entry
// points work: `bun run release:check` locally and `node scripts/release-check.mjs` in CI
// before Bun is set up.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractEntry, normalizeVersion } from "./changelog-entry.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const USAGE = "usage: node scripts/release-check.mjs [version]";

/** Rule 3's heading shape; the date is part of the rule, not decoration. */
const DATED_HEADING = /^## \[[^\]]+\] - \d{4}-\d{2}-\d{2}$/;

/** Rule 4a: a released version links `…/compare/vPREV...vVERSION`. */
const VERSION_LINK = /\/compare\/v([^/\s]+)\.\.\.v(\S+)$/;

/** Rule 4b: `[Unreleased]` links `…/compare/vVERSION...HEAD` after a release. */
const UNRELEASED_LINK = /\/compare\/v(\S+)\.\.\.HEAD$/;

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `"0.6.4"` for a usable value, `missing` for anything else, so a message reads aloud. */
function describe(value) {
	return typeof value === "string" ? `"${value}"` : "missing";
}

function parseJson(source) {
	try {
		return { value: JSON.parse(source) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** The `[label]: url` definition, or null when the document defines none. */
function linkDefinition(markdown, label) {
	const pattern = new RegExp(`^\\[${escapeRegExp(label)}\\]:\\s*(\\S+)\\s*$`, "m");
	const match = pattern.exec(markdown);
	return match === null ? null : match[1];
}

/** The first `## [version]` heading, verbatim; `""` when there is none to judge. */
function headingLine(markdown, version) {
	const pattern = new RegExp(`^## \\[${escapeRegExp(version)}\\](\\s|$)`);
	return markdown.split(/\r?\n/).find((line) => pattern.test(line)) ?? "";
}

/** Everything in a section body that actually says something: prose and list items, not headings. */
function hasContent(body) {
	return body.split(/\r?\n/).some((line) => line.trim() !== "" && !/^#{1,6}\s/.test(line));
}

/** Rule 1. */
function checkPackageJson(source, version) {
	const manifest = parseJson(source);
	if (manifest.error) return [`package.json: not valid JSON (${manifest.error})`];
	const actual = manifest.value?.version;
	if (actual === version) return [];
	return [`package.json: version is ${describe(actual)}, expected "${version}"`];
}

/** Rule 2 — both lockfile version fields, reported separately because they are edited separately. */
function checkPackageLock(source, version) {
	const lock = parseJson(source);
	if (lock.error) return [`package-lock.json: not valid JSON (${lock.error})`];

	const violations = [];
	const root = lock.value?.version;
	if (root !== version) violations.push(`package-lock.json: version is ${describe(root)}, expected "${version}"`);
	const entry = lock.value?.packages?.[""]?.version;
	if (entry !== version) {
		violations.push(`package-lock.json: packages[""].version is ${describe(entry)}, expected "${version}"`);
	}
	return violations;
}

/** Rule 3 — a dated section for the release, with `[Unreleased]` emptied for the next cycle. */
function checkChangelogSection(markdown, version) {
	const violations = [];
	if (extractEntry(markdown, version).status === "missing") {
		violations.push(`CHANGELOG.md: no "## [${version}]" section`);
	} else if (!DATED_HEADING.test(headingLine(markdown, version))) {
		violations.push(`CHANGELOG.md: the "## [${version}]" heading has no "- YYYY-MM-DD" date`);
	}

	const unreleased = extractEntry(markdown, "Unreleased");
	if (unreleased.status === "missing") {
		violations.push('CHANGELOG.md: no "[Unreleased]" section');
	} else if (unreleased.status === "ok" && hasContent(unreleased.body)) {
		// A body of nothing but `### Added` / `### Fixed` headings comes back as `ok` and is
		// empty for this rule, which is why the body is judged rather than the status.
		violations.push(`CHANGELOG.md: [Unreleased] is not empty — move its notes into [${version}]`);
	}
	return violations;
}

/** Rule 4 — the compare links that make the notes navigable. */
function checkCompareLinks(markdown, version) {
	const violations = [];

	const released = linkDefinition(markdown, version);
	if (released === null) {
		violations.push(`CHANGELOG.md: no "[${version}]:" link definition`);
	} else {
		const match = VERSION_LINK.exec(released);
		if (match === null || match[2] !== version) {
			violations.push(`CHANGELOG.md: "[${version}]:" is not a "…/compare/vPREV...v${version}" link: ${released}`);
		}
	}

	const unreleased = linkDefinition(markdown, "Unreleased");
	if (unreleased === null) {
		violations.push('CHANGELOG.md: no "[Unreleased]:" link definition');
	} else {
		const match = UNRELEASED_LINK.exec(unreleased);
		if (match === null || match[1] !== version) {
			violations.push(`CHANGELOG.md: "[Unreleased]:" must point at "…/compare/v${version}...HEAD": ${unreleased}`);
		}
	}
	return violations;
}

/**
 * Every violated release rule in `files`, one human-readable message each; an empty array is
 * the pass. `version` is compared verbatim, so callers normalise `v1.2.3` themselves.
 */
export function checkRelease(files, version) {
	return [
		...checkPackageJson(files.packageJson, version),
		...checkPackageLock(files.packageLock, version),
		...checkChangelogSection(files.changelog, version),
		...checkCompareLinks(files.changelog, version),
	];
}

function readReleaseFiles() {
	try {
		return {
			packageJson: readFileSync(join(ROOT, "package.json"), "utf8"),
			packageLock: readFileSync(join(ROOT, "package-lock.json"), "utf8"),
			changelog: readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"),
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.error(`unreadable release files in ${ROOT}: ${reason}`);
		return null;
	}
}

function main(argv) {
	if (argv.length > 1) {
		console.error(USAGE);
		return 2;
	}

	const files = readReleaseFiles();
	if (files === null) return 2;

	let version = argv[0];
	if (version === undefined) {
		const manifest = parseJson(files.packageJson);
		if (manifest.error || typeof manifest.value?.version !== "string") {
			console.error(`${USAGE} (package.json carries no version to default to)`);
			return 2;
		}
		version = manifest.value.version;
	}
	version = normalizeVersion(version);

	const violations = checkRelease(files, version);
	if (violations.length === 0) {
		console.log(`release contract holds for ${version}`);
		return 0;
	}
	for (const violation of violations) console.error(violation);
	console.error(`release contract fails for ${version}: ${violations.length} violated rule(s)`);
	return 1;
}

const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
