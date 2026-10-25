import { expect, test } from "bun:test";
import { createRecordingController } from "../extensions/voice/recording-controller";
import { startRecordingEntry, type RecordingEntryDeps } from "../extensions/voice/recording-entry";
import { createRecordingOwner } from "../extensions/voice/preview-entrypoint";
import { createPreviewClient } from "../extensions/voice/preview-worker-client";

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

test("generation increments on every start and stale continuations do nothing", async () => {
	const controller = createRecordingController({ debug() {} });
	const deps: RecordingEntryDeps<null> = {
		recordingController: controller,
		debug() {},
		setState: (state) => controller.setState(state),
		abortPreview() {},
		setOwner() {},
		getContext: () => null,
		getConfig: () => ({ previewEnabled: false }),
		resolvePreviewModelDir: () => null,
		createRecordingOwner,
		createPreviewClient,
		retirePreviewClient() {
			throw new Error("disabled preview should reuse its client");
		},
		preview: { client: null, modelDir: null, finish: null },
	};
	expect(controller.generation).toBe(0);
	const first = startRecordingEntry(deps);
	expect(first.generation).toBe(1);
	expect(first.current()).toBe(true);
	const second = startRecordingEntry(deps);
	expect(second.generation).toBe(2);
	expect(first.current()).toBe(false);
	expect(second.current()).toBe(true);
	await first.owner.stop(
		async () => {
			throw new Error("stale final pass");
		},
		async () => {
			throw new Error("stale drain");
		}
	);
	expect(first.owner.deliver()).toBe(false);
	expect(second.owner.deliver()).toBe(true);
	await second.client.destroy();
	const other = createRecordingController({ debug() {} });
	expect(other.generation).toBe(0);
});
