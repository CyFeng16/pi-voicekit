#!/usr/bin/env node
// scripts/upstream-compat.mjs
//
// Typecheck `extensions/` against an arbitrary upstream Pi release, in a throwaway
// directory, so we learn about upstream breakage before the day we upgrade the
// production CLI. Repository-side tool: `package.json` -> `files` is an allow-list
// that does not include `scripts/`, so this never ships to npm consumers.
//
//   node scripts/upstream-compat.mjs            # probe the latest upstream release
//   node scripts/upstream-compat.mjs 0.99.1     # probe one exact release
//   node scripts/upstream-compat.mjs --keep     # keep the scratch tree for inspection
//
// The probe verifies the type surface only. Event timing, overlay lifecycles and
// audio behaviour still need a real session on the production baseline.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_TARGET = "latest";

/** Host-provided packages the probe pins to the target release (see docs/packages.md). */
export const HOST_PACKAGES = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"];

const VERSION_PATTERN = /^v?(\d+\.\d+\.\d+)$/;
const USAGE = "usage: node scripts/upstream-compat.mjs [<version>|latest] [--keep] [--json]";

/** Thrown for malformed invocations; `main` maps it to exit code 2. */
export class UsageError extends Error {}

export function parseArgs(argv) {
	const options = { target: DEFAULT_TARGET, keep: false, json: false, help: false };
	let positionals = 0;
	for (const arg of argv) {
		if (arg === "--keep") options.keep = true;
		else if (arg === "--json") options.json = true;
		else if (arg === "--help" || arg === "-h") options.help = true;
		else if (arg.startsWith("--")) throw new UsageError(`unknown flag: ${arg}`);
		else if (++positionals > 1) throw new UsageError(`expected at most one target, got ${positionals}`);
		else options.target = arg;
	}
	return options;
}

/** Normalise a target into the exact string the throwaway manifest carries. */
export function resolveTargetSpec(target) {
	if (target === DEFAULT_TARGET) return DEFAULT_TARGET;
	const match = VERSION_PATTERN.exec(String(target).trim());
	if (!match) throw new UsageError(`expected "latest" or a full x.y.z version, got "${target}"`);
	return match[1];
}

/**
 * Copy of `manifest` with both host packages pinned to `spec`; peers stay `*` and the repository's own
 * `overrides` are dropped, because the probe tree has to model what upstream Pi itself resolves.
 */
export function applyTargetVersions(manifest, spec) {
	const patched = structuredClone(manifest);
	delete patched.overrides;
	patched.devDependencies = { ...(patched.devDependencies ?? {}) };
	for (const name of HOST_PACKAGES) patched.devDependencies[name] = spec;
	return patched;
}

function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
	return {
		status: result.status,
		failed: result.status !== 0,
		output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
		missing: Boolean(result.error),
	};
}

function resolvedVersions(workdir) {
	const versions = {};
	for (const name of HOST_PACKAGES) {
		try {
			const manifest = JSON.parse(readFileSync(join(workdir, "node_modules", name, "package.json"), "utf8"));
			versions[name] = manifest.version ?? "unknown";
		} catch {
			versions[name] = "unresolved";
		}
	}
	return versions;
}

/** Build the throwaway tree, install the target release and typecheck `extensions/`. */
export function probe({ target = DEFAULT_TARGET, keep = false } = {}) {
	const spec = resolveTargetSpec(target);
	const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
	const patched = applyTargetVersions(manifest, spec);
	const workdir = mkdtempSync(join(tmpdir(), "pi-voicekit-upstream-"));
	let install;
	let typecheck;
	let resolved;
	try {
		cpSync(join(REPO_ROOT, "tsconfig.json"), join(workdir, "tsconfig.json"));
		cpSync(join(REPO_ROOT, "extensions"), join(workdir, "extensions"), { recursive: true });
		writeFileSync(join(workdir, "package.json"), `${JSON.stringify(patched, null, "\t")}\n`);

		install = run("bun", ["install", "--silent"], workdir);
		typecheck =
			install.failed || install.missing
				? { status: null, failed: true, output: "", missing: false, skipped: true }
				: run("bunx", ["tsc", "-p", "tsconfig.json", "--noEmit"], workdir);
		resolved = resolvedVersions(workdir);
	} finally {
		if (!keep) rmSync(workdir, { recursive: true, force: true });
	}
	return {
		target,
		spec,
		keep,
		resolved,
		install,
		typecheck,
		passed: !install.failed && !typecheck.failed,
		workdir: keep ? workdir : null,
	};
}

function describe(result) {
	const lines = [
		"upstream compat probe",
		`  target:   ${result.target} (${result.spec})`,
		...(result.keep ? [`  workdir:  ${result.workdir}`] : []),
	];
	for (const [name, version] of Object.entries(result.resolved)) lines.push(`  resolved: ${name} ${version}`);
	if (result.install.failed) lines.push("  install:  FAILED");
	if (result.typecheck.failed && !result.typecheck.skipped) lines.push("  typecheck: FAILED");
	lines.push(`  verdict:  ${result.passed ? "PASS" : "FAIL"}`);
	return lines.join("\n");
}

function emitLogs(result) {
	if (result.install.failed) process.stderr.write(`${result.install.output}\n`);
	if (result.typecheck.failed && !result.typecheck.skipped) process.stderr.write(`${result.typecheck.output}\n`);
}

export function main(argv) {
	let options;
	try {
		options = parseArgs(argv);
	} catch (error) {
		if (!(error instanceof UsageError)) throw error;
		console.error(error.message);
		console.error(USAGE);
		return 2;
	}
	if (options.help) {
		console.log(USAGE);
		return 0;
	}
	let result;
	try {
		result = probe(options);
	} catch (error) {
		if (!(error instanceof UsageError)) throw error;
		console.error(error.message);
		console.error(USAGE);
		return 2;
	}
	emitLogs(result);
	if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	else console.log(describe(result));
	return result.passed ? 0 : 1;
}

const invokedDirectly = process.argv[1]
	? import.meta.url === pathToFileURL(process.argv[1]).href
	: false;
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
