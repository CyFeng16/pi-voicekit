import { expect, test } from "bun:test";
import { lifecycleHarness } from "./recording-lifecycle-harness";

// Real lifecycle + presenter; only device/process/timer/UI boundaries are replaced.
for (const captureAvailable of [false, true]) {
	test(`entrypoint ${captureAvailable ? "mounts only after capture succeeds" : "does not mount when capture is unavailable"}`, async () => {
		const h = lifecycleHarness({ captureAvailable, missing: true });
		try {
			const started = await h.lifecycle.startRecording();
			expect(started).toBe(captureAvailable);
			expect(h.events).toEqual(
				captureAvailable
					? ["state:recording", "capture-detect", "capture-start", "mount", "sound:start"]
					: ["state:recording", "capture-detect", "sound:error", "state:idle", "state:idle"]
			);
			expect(h.notices).toEqual(
				captureAvailable
					? []
					: ["Voice error: No audio capture tool found. Install one of: sox, ffmpeg, or arecord (Linux)"]
			);
		} finally {
			h.dispose();
		}
	});
}
