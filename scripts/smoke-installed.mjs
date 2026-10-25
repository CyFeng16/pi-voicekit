/**
 * Installed-state smoke: pack the package, install the tarball the way `npm install`
 * would, and start both worker entries under the real Node binary.
 *
 * Why this exists: 0.6.4 shipped the worker entries as TypeScript. Node refuses to
 * strip types for files under `node_modules` —
 *
 *   "Stripping types is currently unsupported for files under node_modules"
 *
 * — so both workers died on import for every installed user and every dictation
 * silently failed, while every test passed because every test ran inside the
 * checkout. `tests/worker-packaging.test.ts` reproduces the installed layout at unit
 * speed; this smoke consumes the artifact a user actually downloads, so `prepack`,
 * the `files` allow-list and the set of published entries are all on the hook.
 *
 * The pass condition is a protocol message, never an exit code. CI supplies no model,
 * so each worker must answer `{ type: "failed" }` with its own missing-model message:
 * `ready` would mean the worker skipped its model check, and a worker that cannot
 * import `sherpa-onnx-node` is the packaging defect arriving through the back door.
 * Both are failures, but so is the expected answer in a gate that only counts exit
 * codes — the message text is what tells them apart, so the text is asserted.
 *
 *   bun run smoke:installed
 *
 *   SMOKE_BREAK=<entry-name>  delete that entry after unpacking and before probing,
 *                             to prove the smoke reports a broken package. Inert when
 *                             unset, so CI never sets it.
 *   SMOKE_KEEP=1              keep the staged tree and print its path.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
/** Where the tarball is unpacked, relative to the temp root: the layout `npm install` produces. */
const INSTALL_DIR = path.join("node_modules", "pi-voicekit");
/** How long a worker may stay silent before the run calls it a hang. */
const PROBE_TIMEOUT_MS = 10_000;
/** The probe's one-line verdicts, in the order they are matched. */
const VERDICT_PREFIXES = [
	["SMOKE:message:", "message"],
	["SMOKE:error:", "error"],
	["SMOKE:exit:", "exit"],
];
/** The worker threads must be started by Node, not Bun: the defect lives in Node's ESM resolver. */
const NODE_BIN = Bun.which("node") ?? "node";

/**
 * The two worker entries and the request each one answers.
 *
 * F7: the final-pass worker needs a real `modelId`, otherwise it answers `Unknown
 * model` and the smoke would prove the wrong branch. Both `modelDir`s point at a
 * directory that does not exist, which is the ordinary first-run state of CI.
 */
const CASES = [
	{
		name: "final-pass-worker",
		entry: "extensions/voice/final-pass-worker.js",
		init: (tempRoot) => ({
			type: "init",
			modelId: "paraformer-zh",
			modelDir: path.join(tempRoot, "no-model"),
			language: "zh",
		}),
		accept: (message) => /^Missing model file: \S+$/.test(message),
		expected: '"failed" with the message "Missing model file: <file>"',
	},
	{
		name: "local-preview-worker",
		entry: "extensions/voice/local-preview-worker.js",
		init: (tempRoot) => ({ type: "init", modelDir: path.join(tempRoot, "no-model") }),
		// The preview worker imports the native addon before it looks for model files, so
		// this message also proves the staged package resolved its dependency.
		accept: (message, tempRoot) =>
			message.startsWith("missing preview model file: ") && message.includes(path.join(tempRoot, "no-model")),
		expected: '"failed" with the message "missing preview model file: <path>"',
	},
];

/** A structural problem: the smoke itself could not be carried out. */
class SmokeError extends Error {}

/**
 * The probe, written into the temp tree and run by the real `node`.
 *
 * It must be a file: `node --input-type=module -e` leaks `--input-type` into the
 * worker's execArgv, and Node rejects that for a file-based worker before it loads
 * anything. `fs.writeSync` rather than `console.log` because `process.exit()`
 * truncates buffered stdout on a pipe.
 *
 * argv: <file URL of the worker entry> <JSON message to post>
 */
const PROBE_SOURCE = `import * as fs from "node:fs";
import { Worker } from "node:worker_threads";

const [entryUrl, payload] = process.argv.slice(2);
const worker = new Worker(new URL(entryUrl));
let finished = false;
let timer;

function finish(line) {
	if (finished) return;
	finished = true;
	clearTimeout(timer);
	fs.writeSync(1, line + "\\n");
	worker.terminate().finally(() => process.exit(0));
}

timer = setTimeout(() => finish("SMOKE:timeout"), ${PROBE_TIMEOUT_MS});
worker.on("message", (message) => finish("SMOKE:message:" + JSON.stringify(message)));
worker.on("error", (error) => finish("SMOKE:error:" + String(error && error.message ? error.message : error).split("\\n")[0]));
worker.on("exit", (code) => finish("SMOKE:exit:" + code));
worker.postMessage(JSON.parse(payload));
`;

/** Run a command with piped output; a missing executable becomes a readable failure, not a stack. */
function run(command, args, options = {}) {
	try {
		const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe", ...options });
		return {
			code: result.exitCode,
			stdout: result.stdout?.toString() ?? "",
			stderr: result.stderr?.toString() ?? "",
		};
	} catch (error) {
		throw new SmokeError(`could not run ${command}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** The first lines of a command's output, for a one-line diagnostic. */
function head(text, lines = 5) {
	const kept = text.trim().split("\n").slice(0, lines).join("\n");
	return kept || "(no output)";
}

/**
 * Pack the repository the way a release does. `--pack-destination` keeps the tarball
 * out of the checkout: without it `npm pack` drops it in the repo root, and `prepack`
 * regenerates the bundles there either way.
 */
function packTarball(tempRoot) {
	const result = run("npm", ["pack", "--pack-destination", tempRoot], { cwd: REPO_ROOT });
	if (result.code !== 0) throw new SmokeError(`npm pack failed (exit ${result.code}):\n${head(result.stderr)}`);
	const tarballs = fs.readdirSync(tempRoot).filter((name) => name.endsWith(".tgz"));
	if (tarballs.length !== 1) {
		throw new SmokeError(`npm pack produced ${tarballs.length} tarballs in ${tempRoot}: ${tarballs.join(", ")}`);
	}
	return path.join(tempRoot, tarballs[0]);
}

/**
 * Install the tarball under `<temp>/node_modules/pi-voicekit`, the layout a real user
 * installs. The paths matter: Node refuses to strip types by path, so a copy staged
 * anywhere else would never reproduce the defect.
 *
 * Dependencies are linked as `<staged>/node_modules` rather than at the temp root,
 * the same layout `tests/worker-packaging.test.ts` proves end to end: a real install
 * puts them next to (or above) the package, and the preview worker's `createRequire`
 * is resolved from inside it.
 */
function installTarball(tarball, tempRoot) {
	const unpackDir = path.join(tempRoot, "unpack");
	fs.mkdirSync(unpackDir, { recursive: true });
	const untar = run("tar", ["-xzf", tarball, "-C", unpackDir], { cwd: tempRoot });
	if (untar.code !== 0) throw new SmokeError(`tar failed (exit ${untar.code}):\n${head(untar.stderr)}`);

	// F11: tarball entries are prefixed `package/`.
	const staged = path.join(unpackDir, "package");
	const installed = path.join(tempRoot, INSTALL_DIR);
	fs.mkdirSync(path.dirname(installed), { recursive: true });
	fs.renameSync(staged, installed);
	fs.rmSync(unpackDir, { recursive: true, force: true });

	const repoModules = path.join(REPO_ROOT, "node_modules");
	if (!fs.existsSync(repoModules)) throw new SmokeError(`${repoModules} is missing; run "bun install" first`);
	fs.symlinkSync(repoModules, path.join(installed, "node_modules"), "dir");
	return installed;
}

/**
 * Probe one entry with the real Node binary and report what it did: the first message
 * it posted, the error that stopped it loading, an early exit, or silence.
 */
function probeEntry(tempRoot, entryPath, init) {
	const result = run(
		NODE_BIN,
		[path.join(tempRoot, "probe.mjs"), pathToFileURL(entryPath).href, JSON.stringify(init)],
		{ cwd: tempRoot, timeout: PROBE_TIMEOUT_MS + 5_000 }
	);
	const verdict = result.stdout.split("\n").find((line) => line.startsWith("SMOKE:"));
	if (!verdict) {
		throw new SmokeError(
			`the probe for ${path.basename(entryPath)} wrote no verdict (exit ${result.code}):\n${head(result.stderr)}`
		);
	}
	for (const [prefix, kind] of VERDICT_PREFIXES) {
		if (!verdict.startsWith(prefix)) continue;
		const detail = verdict.slice(prefix.length);
		if (kind === "message") return { kind, message: JSON.parse(detail) };
		if (kind === "exit") return { kind, code: detail };
		return { kind, detail };
	}
	return { kind: "timeout" };
}

/** Why the outcome is not the expected missing-model failure, or `null` when it is. */
function describeProblem(item, outcome, tempRoot) {
	if (outcome.kind === "error") return `worker failed to load: ${outcome.detail}`;
	if (outcome.kind === "exit") return `worker exited (code ${outcome.code}) before it posted a message`;
	if (outcome.kind === "timeout") return `worker posted no message within ${PROBE_TIMEOUT_MS} ms`;

	const message = outcome.message;
	if (message?.type !== "failed") {
		return `first message was ${JSON.stringify(message)}, expected ${item.expected}`;
	}
	if (typeof message.message !== "string" || !item.accept(message.message, tempRoot)) {
		return `first message was ${JSON.stringify(message)}, expected ${item.expected}`;
	}
	return null;
}

/** Run the whole check and return the number of workers that did not report as expected. */
function runSmoke(tempRoot) {
	const tarball = packTarball(tempRoot);
	const installed = installTarball(tarball, tempRoot);
	fs.writeFileSync(path.join(tempRoot, "probe.mjs"), PROBE_SOURCE);

	for (const item of CASES) {
		if (!fs.existsSync(path.join(installed, item.entry))) {
			throw new SmokeError(`the packed tarball has no ${item.entry}`);
		}
	}

	const broken = process.env.SMOKE_BREAK?.trim();
	if (broken) {
		const item = CASES.find((candidate) => candidate.name === broken);
		if (!item)
			throw new SmokeError(`SMOKE_BREAK=${broken} names no worker entry (${CASES.map((c) => c.name).join(", ")})`);
		fs.rmSync(path.join(installed, item.entry));
		console.log(`break: removed ${item.entry} so the load failure can be proved`);
	}

	let failed = 0;
	for (const item of CASES) {
		const outcome = probeEntry(tempRoot, path.join(installed, item.entry), item.init(tempRoot));
		const problem = describeProblem(item, outcome, tempRoot);
		if (problem) {
			failed++;
			console.error(`not ok ${item.name}: ${problem}`);
			continue;
		}
		console.log(`ok ${item.name}: failed (${outcome.message.message})`);
	}
	return failed;
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "voicekit-smoke-"));
let exitCode = 0;
try {
	exitCode = runSmoke(tempRoot) === 0 ? 0 : 1;
} catch (error) {
	if (!(error instanceof SmokeError)) throw error;
	console.error(`smoke: ${error.message}`);
	exitCode = 1;
} finally {
	if (process.env.SMOKE_KEEP === "1") console.log(`smoke: kept ${tempRoot}`);
	else fs.rmSync(tempRoot, { recursive: true, force: true });
}
process.exit(exitCode);
