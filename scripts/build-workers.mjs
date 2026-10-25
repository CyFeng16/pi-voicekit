/**
 * Bundle the recogniser worker entries to JavaScript.
 *
 * Why this exists: Node refuses to strip types for files under `node_modules`
 * ("Stripping types is currently unsupported for files under node_modules"), and a
 * worker is loaded by the runtime's plain ESM resolver — not by the host's
 * transpiler that loads the extension itself. Shipping only `.ts` entries meant
 * `pi-voicekit@0.6.4` started neither worker once installed: the preview stayed
 * silent and every dictation failed, because the final transcription runs in one.
 *
 * Each entry is bundled into a single self-contained `.js` beside its source. The
 * native addon stays external: it is CommonJS with a `.node` binary and must be
 * resolved by `createRequire` at runtime, exactly as before.
 *
 * Runs from `prepack`, so `npm publish` and `npm pack` both produce bundles.
 * The output is git-ignored; the TypeScript sources remain the entries in the
 * repository and for the test suite.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const VOICE_DIR = path.join(ROOT, "extensions", "voice");
const ENTRIES = ["local-preview-worker", "final-pass-worker"];
const EXTERNAL = ["sherpa-onnx-node"];

function fail(message) {
	console.error(`build-workers: ${message}`);
	process.exit(1);
}

for (const name of ENTRIES) {
	const entry = path.join(VOICE_DIR, `${name}.ts`);
	if (!fs.existsSync(entry)) fail(`missing entry ${entry}`);

	const result = Bun.spawnSync(
		[
			process.execPath,
			"build",
			entry,
			"--target=node",
			"--format=esm",
			"--outfile",
			path.join(VOICE_DIR, `${name}.js`),
			...EXTERNAL.flatMap((mod) => ["--external", mod]),
		],
		{ cwd: ROOT, stdout: "pipe", stderr: "pipe" }
	);

	if (result.exitCode !== 0) {
		fail(`bundling ${name}.ts failed:\n${result.stderr?.toString() ?? ""}${result.stdout?.toString() ?? ""}`);
	}

	const outFile = path.join(VOICE_DIR, `${name}.js`);
	const size = fs.statSync(outFile).size;
	if (size === 0) fail(`${outFile} is empty`);
	console.log(`build-workers: ${name}.js (${size} bytes)`);
}
