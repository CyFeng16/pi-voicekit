import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRecordingController } from "../extensions/voice/recording-controller";

test("the controller owns the state and reports the value it was given", () => {
	const transitions: string[] = [];
	const controller = createRecordingController({ debug: (message) => transitions.push(message) });

	expect(controller.state).toBe("idle");
	controller.setState("warmup");
	expect(controller.state).toBe("warmup");
	controller.setState("recording");
	expect(controller.state).toBe("recording");
	controller.setState("finalizing");
	expect(controller.state).toBe("finalizing");
	controller.setState("idle");
	expect(controller.state).toBe("idle");

	expect(transitions).toEqual([
		"STATE: idle → warmup",
		"STATE: warmup → recording",
		"STATE: recording → finalizing",
		"STATE: finalizing → idle",
	]);
});

test("a repeated state is applied but not logged as a transition", () => {
	const transitions: string[] = [];
	const controller = createRecordingController({ debug: (message) => transitions.push(message) });

	controller.setState("recording");
	controller.setState("recording");

	expect(controller.state).toBe("recording");
	expect(transitions).toEqual(["STATE: idle → recording"]);
});

test("every entrypoint state transition goes through the controller", () => {
	// Temporary marker, not a behavioural test: the entrypoint exposes no seam that reaches the
	// controller instance it builds, so assert the source shape the delegation requires. Task 7b
	// replaces this with a behavioural assertion once the start/stop seam exists.
	const source = readFileSync(new URL("../extensions/voice.ts", import.meta.url), "utf8");
	const setVoiceStateBody = source.slice(
		source.indexOf("\tfunction setVoiceState("),
		source.indexOf("\n\t// ─── Cleanup helpers")
	);

	expect(setVoiceStateBody).toContain("recordingController.setState(newState)");
	// The entrypoint keeps no state value of its own: nothing declares or assigns `voiceState`.
	expect(source).not.toMatch(/\b(?:let|const|var)\s+voiceState\b/);
	expect(source).not.toMatch(/[^.\w]voiceState\s*=(?!=)/);
});
