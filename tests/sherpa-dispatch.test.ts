import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The dispatch-branch assertions live in tests/sherpa-dispatch-probe.ts and run
// in their OWN bun test subprocess, because bun.mock.module's registry is
// process-global: running that mock inline here leaked it into sibling test
// files of the same `bun test` batch (tests/sherpa-engine.test.ts observed
// version "0.0.0-mock" and a missing OnlineRecognizer on CI).
describe("recognizer dispatch (mock, subprocess-isolated)", () => {
	test("probe subprocess passes all mocked-engine branches", () => {
		// The probe also pins the VAD configuration, which only reaches the VAD when a Silero
		// model looks installed. Give the subprocess a temporary HOME with a marker file so the
		// assertion never depends on — or touches — the developer's real ~/.pi/models/vad.
		const home = mkdtempSync(join(tmpdir(), "pi-voicekit-vad-home-"));
		const vadDir = join(home, ".pi", "models", "vad");
		mkdirSync(vadDir, { recursive: true });
		writeFileSync(join(vadDir, "silero_vad.onnx"), "");
		try {
			const r = spawnSync("bun", ["test", "./tests/sherpa-dispatch-probe.ts"], {
				encoding: "utf8",
				timeout: 60_000,
				env: { ...process.env, HOME: home },
			});
			if (r.status !== 0) console.error("probe stdout:\n" + r.stdout + "\nprobe stderr:\n" + r.stderr);
			expect(r.status).toBe(0);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
