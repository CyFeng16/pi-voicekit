// tests/worker-import-graph.test.ts
//
// A worker entry is loaded by the runtime's own ESM resolver — not a bundler, and not the host's
// TypeScript loader (jiti), which is not installed in the worker thread. Node resolves only specifiers
// that name a file, so `import { x } from "./preview-stream"` is `ERR_MODULE_NOT_FOUND` inside the worker
// while the rest of the extension, which jiti resolves, keeps working. `bun test` resolves extensionless
// imports happily, so that invariant cannot live in a comment: an extensionless value import added
// anywhere in the worker's reachable graph would keep CI green and fail only on a user's machine, at
// worker load time, with no `failed` message and no test to point at.
//
// This gate therefore walks the worker's static import graph and requires every relative value import to
// name its file with a `.ts` extension. A pure source scan, no worker spawn: the static graph is what the
// runtime loads, so it is what is walked.
//
// Scope of the walk:
// - Type-only imports are skipped. The transpiler erases them, so they never reach the resolver:
//   `local.ts`'s `import type { VoiceConfig } from "./config"` is exactly such a specifier, and it must
//   not be reported.
// - Bare specifiers are Node's to resolve (`sherpa-onnx-node` arrives through `createRequire`), so only
//   relative ones carry the `.ts` rule.
// - Dynamic `import()` targets are out of scope: they are not evaluated when the module loads, so they
//   cannot break worker startup. A gate that policed them would have to flag `local.ts`'s lazy engine
//   imports, which are unrelated to this entry.
//
// AGENTS.md records the other half of the same invariant — a module reachable from a worker entry must
// stay erasable-only TypeScript — which a source scan cannot decide, so it stays a review rule.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const WORKER_ENTRY = "extensions/voice/local-preview-worker.ts";
const WORKER_ENTRIES = [...new Bun.Glob("extensions/**/*-worker.ts").scanSync(REPO_ROOT)];

/** The import kinds `scanImports` reports that load a module at run time; type-only imports never appear. */
const VALUE_KINDS = new Set(["import-statement", "require-call", "require-resolve"]);

// A real parser, not a regex over the text: prose in the rationale above and look-alikes inside template
// literals must never be mistaken for an import.
const scanner = new Bun.Transpiler({ loader: "ts" });

/** One value import: the file that carries it and the specifier exactly as written. */
interface ValueImport {
	file: string;
	specifier: string;
}

function isRelative(specifier: string): boolean {
	return specifier.startsWith("./") || specifier.startsWith("../");
}

/** Value imports of the relative kind only — the ones the runtime must resolve to a file on disk. */
function relativeValueImports(file: string, source: string = readFileSync(file, "utf8")): ValueImport[] {
	return scanner
		.scanImports(source)
		.filter((hit) => VALUE_KINDS.has(hit.kind) && isRelative(hit.path))
		.map((hit) => ({ file, specifier: hit.path }));
}

/**
 * Walk the static graph from `entry`, descending through relative value imports.
 *
 * Only a specifier that already ends in `.ts` is followed: an extensionless one is the violation this
 * gate exists to report, and resolving it here would replace that report with a "file not found" for a
 * path the runtime never asks for. Imports are collected before the descent, so an offending file is
 * reported even when nothing behind it can be read.
 */
function reachableGraph(entry: string): { files: string[]; imports: ValueImport[] } {
	const files: string[] = [];
	const imports: ValueImport[] = [];
	const pending = [resolve(REPO_ROOT, entry)];
	const seen = new Set<string>();

	while (pending.length > 0) {
		const file = pending.pop() as string;
		if (seen.has(file)) continue;
		seen.add(file);
		// A `.ts` specifier that resolves nowhere is the same class of load-time failure as a missing
		// extension, and a silently shorter graph would weaken every assertion below.
		if (!existsSync(file)) throw new Error(`import graph names a file that does not exist: ${repoPath(file)}`);
		files.push(file);

		for (const found of relativeValueImports(file)) {
			imports.push(found);
			if (found.specifier.endsWith(".ts")) pending.push(resolve(dirname(file), found.specifier));
		}
	}

	return { files, imports };
}

/** Repo-relative, so a failure names the file a reader can open rather than an absolute path. */
function repoPath(file: string): string {
	return relative(REPO_ROOT, file);
}

/** The violations, as `file: specifier`, in walk order. */
function extensionless(imports: ValueImport[]): string[] {
	return imports
		.filter((found) => !found.specifier.endsWith(".ts"))
		.map((found) => `${repoPath(found.file)}: ${found.specifier}`);
}

test.each(WORKER_ENTRIES)("every value import %s loads names its file with a .ts extension", (entry) => {
	const { files, imports } = reachableGraph(entry);

	expect(extensionless(imports)).toEqual([]);
	// Liveness: neither entry nor its decoding implementation may disappear from the walk.
	const implementation = entry.endsWith("final-pass-worker.ts") ? "sherpa-engine.ts" : "preview-stream.ts";
	expect(files.map(repoPath)).toEqual(
		expect.arrayContaining([entry, "extensions/voice/local.ts", `extensions/voice/${implementation}`])
	);
});

test("the entry glob includes both independent recognition workers", () => {
	expect(WORKER_ENTRIES).toEqual(expect.arrayContaining([WORKER_ENTRY, "extensions/voice/final-pass-worker.ts"]));
});

test("the walk would catch an extensionless value import and ignores a type-only one", () => {
	// Proves the gate can fail at all: `from "./preview-stream"` is the exact regression it guards, and a
	// scanner that reported nothing (an API change, a wrong loader) would pass the real graph above.
	expect(
		extensionless(relativeValueImports(WORKER_ENTRY, 'import { createPreviewStream } from "./preview-stream";'))
	).toEqual([`${WORKER_ENTRY}: ./preview-stream`]);
	expect(relativeValueImports(WORKER_ENTRY, 'import type { VoiceConfig } from "./config";')).toEqual([]);
});
