/**
 * Resolve the entry point for a recogniser worker.
 *
 * The published package ships a **bundled JavaScript** entry next to each TypeScript
 * source, because Node refuses to strip types for files under `node_modules`:
 *
 *   "Stripping types is currently unsupported for files under node_modules"
 *
 * The extension itself is loaded by Pi's own transpiler, so it starts fine either
 * way — but a worker is loaded by the runtime's plain ESM resolver, and a `.ts`
 * entry there fails at import time and takes the feature down with it. The bundles
 * are produced by `scripts/build-workers.mjs` (wired to `prepack`), and the
 * TypeScript source remains the entry everywhere the bundle is absent: the test
 * suite and any checkout of this repository.
 */
import * as fs from "node:fs";

/** Name of a worker entry, without extension. */
export type WorkerEntryName = "local-preview-worker" | "final-pass-worker";

/**
 * Pick the bundled `.js` when the package ships one, otherwise the `.ts` source.
 * `moduleUrl` is the calling module's `import.meta.url`, so the entry is always
 * resolved next to the code that spawns it.
 */
export function resolveWorkerEntry(name: WorkerEntryName, moduleUrl: string): URL {
	const bundled = new URL(`./${name}.js`, moduleUrl);
	if (fs.existsSync(bundled)) return bundled;
	return new URL(`./${name}.ts`, moduleUrl);
}
