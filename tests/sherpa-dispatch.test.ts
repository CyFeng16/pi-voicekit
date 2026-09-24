import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// The dispatch-branch assertions live in tests/sherpa-dispatch-probe.ts and run
// in their OWN bun test subprocess, because bun.mock.module's registry is
// process-global: running that mock inline here leaked it into sibling test
// files of the same `bun test` batch (tests/sherpa-engine.test.ts observed
// version "0.0.0-mock" and a missing OnlineRecognizer on CI).
describe("recognizer dispatch (mock, subprocess-isolated)", () => {
	test("probe subprocess passes all dispatch branches", () => {
		const r = spawnSync("bun", ["test", "./tests/sherpa-dispatch-probe.ts"], {
			encoding: "utf8",
			timeout: 60_000,
		});
		if (r.status !== 0) console.error("probe stdout:\n" + r.stdout + "\nprobe stderr:\n" + r.stderr);
		expect(r.status).toBe(0);
	});
});
