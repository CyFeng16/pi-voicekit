/**
 * Packaging gate: both worker entries must run from an *installed* copy.
 *
 * Every other test executes inside the repository tree, where the entry sits at a
 * path Node is happy to type-strip. An installed extension lives under
 * `node_modules/`, and Node refuses to strip types there:
 *
 *   "Stripping types is currently unsupported for files under node_modules"
 *
 * Pi itself loads the extension through its own transpiler, so the failure only
 * shows up in the worker: `new Worker(new URL("./x-worker.ts", import.meta.url))`
 * goes through Node's plain ESM resolver, dies at import time, and takes the whole
 * feature with it (the final transcription fails, so a dictation writes nothing).
 *
 * This test reproduces the installed layout — a copy of the package under a
 * `node_modules/` directory — and spawns the entry with the real `node` binary.
 * 0.6.4 shipped broken precisely because no test ever left the repository tree.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// A clean checkout has no bundles — they are produced by `prepack` at packaging time.
// Build them here so this gate runs everywhere, and so CI proves the build itself works.
beforeAll(() => {
	const build = Bun.spawnSync([process.execPath, path.join(REPO_ROOT, "scripts", "build-workers.mjs")], {
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (build.exitCode !== 0) {
		throw new Error(`build-workers failed: ${build.stderr?.toString() ?? ""}${build.stdout?.toString() ?? ""}`);
	}
});

/**
 * Copy the package into `<tmp>/node_modules/pi-voicekit/` the way `npm install`
 * would lay it out, so any path-based runtime restriction applies as it would for
 * a real user.
 */
function stageInstalledCopy(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "voicekit-pkg-"));
	tempDirs.push(root);
	const target = path.join(root, "node_modules", "pi-voicekit");
	fs.mkdirSync(target, { recursive: true });
	for (const entry of ["extensions", "package.json"]) {
		fs.cpSync(path.join(REPO_ROOT, entry), path.join(target, entry), { recursive: true });
	}
	// A real install resolves dependencies next to (or above) the package; the native addon
	// is required at runtime through `createRequire`, so the stage needs it too.
	fs.symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(target, "node_modules"), "dir");
	return target;
}

/**
 * Spawn a worker entry under the real Node binary and report what it does: the
 * first message it posts, or the error that stopped it loading.
 */
async function probeWorker(entryPath: string): Promise<{ kind: "message" | "error" | "timeout"; detail: string }> {
	const script = `
		import { Worker } from "node:worker_threads";
		const w = new Worker(new URL(${JSON.stringify(`file://${entryPath}`)}));
		w.on("error", (e) => { console.log("ERROR:" + String(e && e.message).split("\\n")[0]); process.exit(0); });
		w.on("message", (m) => { console.log("MESSAGE:" + JSON.stringify(m)); process.exit(0); });
		w.postMessage({ type: "init", modelDir: "/nonexistent-model-dir", language: "zh" });
		setTimeout(() => { console.log("TIMEOUT:"); process.exit(0); }, 8000);
	`;
	fs.writeFileSync(path.join(path.dirname(entryPath), ".probe.mjs"), script);
	try {
		// Must be the Node binary, not the test runner: the defect is specific to Node's
		// ESM resolver, and Bun strips types anywhere so it would never reproduce.
		const nodeBin = Bun.which("node") ?? "node";
		const proc = Bun.spawnSync([nodeBin, path.join(path.dirname(entryPath), ".probe.mjs")], {
			timeout: 20_000,
		});
		const out = `${proc.stdout?.toString() ?? ""}${proc.stderr?.toString() ?? ""}`.trim();
		if (out.startsWith("MESSAGE:")) return { kind: "message", detail: out.slice("MESSAGE:".length) };
		if (out.startsWith("ERROR:")) return { kind: "error", detail: out.slice("ERROR:".length) };
		return { kind: "timeout", detail: out };
	} finally {
		fs.rmSync(path.join(path.dirname(entryPath), ".probe.mjs"), { force: true });
	}
}

describe("resolveWorkerEntry", () => {
	// The selector is what keeps a checkout on the TypeScript source and a published
	// package on the bundled JavaScript. Both halves are pinned here because either
	// one alone regresses silently.
	test("prefers the bundled JavaScript when the package ships one", async () => {
		const { resolveWorkerEntry } = await import("../extensions/voice/worker-entry");
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voicekit-entry-"));
		tempDirs.push(dir);
		fs.writeFileSync(path.join(dir, "local-preview-worker.ts"), "");
		fs.writeFileSync(path.join(dir, "local-preview-worker.js"), "");
		expect(resolveWorkerEntry("local-preview-worker", `file://${dir}/client.ts`).pathname).toBe(
			`${dir}/local-preview-worker.js`
		);
	});

	test("falls back to the TypeScript source in a checkout", async () => {
		const { resolveWorkerEntry } = await import("../extensions/voice/worker-entry");
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voicekit-entry-"));
		tempDirs.push(dir);
		fs.writeFileSync(path.join(dir, "local-preview-worker.ts"), "");
		expect(resolveWorkerEntry("local-preview-worker", `file://${dir}/client.ts`).pathname).toBe(
			`${dir}/local-preview-worker.ts`
		);
	});

	// A hardcoded `.ts` URL is exactly the 0.6.4 defect; keep both spawn sites on the selector.
	test("both clients resolve their entry through the selector", () => {
		for (const file of ["preview-worker-client.ts", "final-pass-client.ts"]) {
			const source = fs.readFileSync(path.join(REPO_ROOT, "extensions", "voice", file), "utf8");
			expect(source).toContain("resolveWorkerEntry(");
			expect(source).not.toMatch(/new URL\("\.\/[a-z-]+-worker\.ts"/);
		}
	});
});

describe("worker packaging", () => {
	// The defect: the shipped entry points at TypeScript, which Node cannot load
	// from node_modules. A missing model is fine — that is a handled failure — so
	// the passing outcome is a `{ type: "failed" }` message, not a load error.
	test("the final-pass worker loads from an installed copy", async () => {
		const installed = stageInstalledCopy();
		const entry = path.join(installed, "extensions", "voice", "final-pass-worker.js");
		expect(fs.existsSync(entry)).toBe(true);

		const probe = await probeWorker(entry);
		expect(`${probe.kind} ${probe.detail}`).toStartWith("message ");
		expect(probe.detail).toContain('"failed"');
	});

	test("the preview worker loads from an installed copy", async () => {
		const installed = stageInstalledCopy();
		const entry = path.join(installed, "extensions", "voice", "local-preview-worker.js");
		expect(fs.existsSync(entry)).toBe(true);

		const probe = await probeWorker(entry);
		expect(`${probe.kind} ${probe.detail}`).toStartWith("message ");
		expect(probe.detail).toContain('"failed"');
	});
});
