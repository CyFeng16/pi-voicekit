import { describe, expect, test } from "bun:test";
import {
	shouldArmReleaseDetectOnRepeat,
	decideRecordingStartTimer,
	type SpaceHoldContext,
} from "../extensions/voice/hold-to-talk";

const base: SpaceHoldContext = {
	voiceState: "idle",
	kittyReleaseDetected: false,
};

describe("shouldArmReleaseDetectOnRepeat (upstream #13)", () => {
	test("recording must re-arm release detection in non-kitty terminals — the #13 regression", () => {
		expect(shouldArmReleaseDetectOnRepeat({ ...base, voiceState: "recording" })).toBe(true);
		expect(shouldArmReleaseDetectOnRepeat({ ...base, voiceState: "recording", kittyReleaseDetected: false })).toBe(
			true
		);
	});

	test("finalizing must keep re-arming release detection", () => {
		expect(shouldArmReleaseDetectOnRepeat({ ...base, voiceState: "finalizing" })).toBe(true);
	});

	test("warmup must NOT arm — an armed timer would hit the warmup-cancel branch (#13 race)", () => {
		// Regression: arming during the recording startup window (voiceState still
		// warmup, spaceConsumed already flipped) fires onSpaceReleaseDetected in the
		// warmup branch and cancels the just-started recording.
		expect(shouldArmReleaseDetectOnRepeat({ ...base, voiceState: "warmup" })).toBe(false);
	});

	test("idle never arms", () => {
		expect(shouldArmReleaseDetectOnRepeat({ ...base, voiceState: "idle" })).toBe(false);
	});

	test("kitty terminals never arm gap detection (real key-release exists)", () => {
		for (const state of ["recording", "finalizing", "warmup", "idle"] as const) {
			expect(shouldArmReleaseDetectOnRepeat({ ...base, voiceState: state, kittyReleaseDetected: true })).toBe(false);
		}
	});
});

describe("decideRecordingStartTimer", () => {
	test("non-kitty hold session (spaceDownTime set) re-arms a fresh timer at start", () => {
		expect(decideRecordingStartTimer({ kittyReleaseDetected: false, isHold: true })).toBe("arm");
	});

	test("toggle/dictation (no spaceDownTime) must NEVER arm — no repeat stream keeps it alive", () => {
		// Regression: arming would auto-stop a toggle recording ~250ms after start.
		expect(decideRecordingStartTimer({ kittyReleaseDetected: false, isHold: false })).toBe("clear");
	});

	test("kitty terminals clear the timer at recording start (key-up event governs)", () => {
		expect(decideRecordingStartTimer({ kittyReleaseDetected: true, isHold: true })).toBe("clear");
		expect(decideRecordingStartTimer({ kittyReleaseDetected: true, isHold: false })).toBe("clear");
	});
});

describe("hold-to-talk release decision stream", () => {
	test("non-kitty: repeats keep the gap timer alive during recording, then a gap ends it", () => {
		// Pure decision stream for the #13 scenario:
		// 1. recording starts → arm is allowed at ready-point
		// 2. every repeat while recording re-arms (250ms each)
		// 3. after release, no repeat → the last armed timer fires → stop
		expect(decideRecordingStartTimer({ kittyReleaseDetected: false, isHold: true })).toBe("arm");
		for (let i = 0; i < 5; i++) {
			expect(shouldArmReleaseDetectOnRepeat({ ...base, voiceState: "recording" })).toBe(true);
		}
	});

	test("kitty mode is never subjected to gap-based release", () => {
		expect(decideRecordingStartTimer({ kittyReleaseDetected: true, isHold: true })).toBe("clear");
		for (const state of ["recording", "finalizing"] as const) {
			expect(shouldArmReleaseDetectOnRepeat({ ...base, voiceState: state, kittyReleaseDetected: true })).toBe(false);
		}
	});
});
