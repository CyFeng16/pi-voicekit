import { expect, test } from "bun:test";
import { createPreviewRetirement } from "../extensions/voice/preview-retirement";
import { createRecordingOwner, resolvePreviewModelDir } from "../extensions/voice/preview-entrypoint";
import { createPreviewSession } from "../extensions/voice/preview-session";
import { classifyOutcome, deliverOutcome } from "../extensions/voice/dictation-outcome";
import { insertTranscript } from "../extensions/voice/editor-sink";

test("the preview model directory is resolved only when installed and enabled", () => {
	const urls: Record<string, string>[] = [];
	const installed = (_id: string, downloads: Record<string, string>) => {
		urls.push(downloads);
		return true;
	};
	expect(resolvePreviewModelDir(false, installed, () => "model")).toBeNull();
	expect(
		resolvePreviewModelDir(
			true,
			() => false,
			() => "model"
		)
	).toBeNull();
	expect(resolvePreviewModelDir(true, installed, () => "model")).toBe("model");
	expect(Object.values(urls[0]!).every((url) => url.startsWith("https://"))).toBe(true);
});

test("a hung preview flush does not delay the final result and stop has one owner", async () => {
	const events: string[] = [];
	const owner = createRecordingOwner(() => true);
	const final = () => {
		events.push("final");
		return Promise.resolve();
	};
	const drain = () => {
		events.push("drain");
		return new Promise<void>(() => {});
	};
	await owner.stop(final, drain);
	await owner.stop(final, drain);
	expect(events).toEqual(["final", "drain"]);
	expect(owner.deliver()).toBe(true);
	expect(owner.deliver()).toBe(false);
});

test("cancel during finalisation or preview drain delivers nothing", async () => {
	const owner = createRecordingOwner(() => true);
	let resolve!: () => void;
	const pending = owner.stop(
		() =>
			new Promise<void>((r) => {
				resolve = r;
			}),
		() => new Promise<void>(() => {})
	);
	owner.cancel();
	resolve();
	await pending;
	expect(owner.deliver()).toBe(false);
});

test("the session alone unmounts once and delivery preserves typing at the cursor", async () => {
	let mounts = 0;
	let unmounts = 0;
	let releases = 0;
	const session = createPreviewSession(
		{
			recordingId: "1",
			feed() {},
			flush: async () => {},
			release() {
				releases++;
			},
			destroy: async () => {},
		},
		{
			mountPanel() {
				mounts++;
			},
			unmountPanel() {
				unmounts++;
			},
			onDegraded() {},
		}
	);
	session.handleEvent({ kind: "partial", recordingId: "1", segmentId: 0, revision: 1, text: "preview" });
	expect(mounts).toBe(1);
	let buffer = "typed while recording|suffix";
	const history: string[] = [];
	const notices: string[] = [];
	deliverOutcome(
		classifyOutcome({ capturedBytes: 2, finalText: "final", finalHadSpeech: true, previewText: session.text }),
		session.degraded,
		{
			hasUI: true,
			clean: (t) => t,
			punctuate: (t) => t,
			addToHistory: (t) => {
				history.push(t);
			},
			notify: (t) => {
				notices.push(t);
			},
			insert: (text) =>
				insertTranscript(
					{
						hasUI: true,
						getEditorText: () => buffer,
						pasteToEditor: (t) => {
							buffer = buffer.replace("|", t + "|");
						},
						setEditorText: () => {
							throw new Error("must not overwrite the editor");
						},
					},
					text
				),
		}
	);
	await session.finish();
	await session.finish();
	session.abort();
	expect(buffer).toBe("typed while recordingfinal|suffix");
	expect(history).toEqual(["final"]);
	expect(notices).toHaveLength(1);
	expect(unmounts).toBe(1);
	expect(releases).toBe(1);
});

test("repeated finishes retain the outstanding drain until the session releases", async () => {
	const retirement = createPreviewRetirement({ debug() {}, safeErrorText: String, setTimeout, clearTimeout });
	const harness = {
		finishPreview: retirement.finishPreview,
		get pending() {
			return retirement.finish;
		},
	};
	let settle!: () => void;
	let releases = 0;
	const session = createPreviewSession(
		{
			recordingId: "old",
			feed() {},
			flush: () =>
				new Promise<void>((resolve) => {
					settle = resolve;
				}),
			release() {
				releases++;
			},
			destroy: async () => {},
		},
		{ mountPanel() {}, unmountPanel() {}, onDegraded() {} }
	);
	const owner = createRecordingOwner(() => true);
	await owner.stop(
		async () => {},
		() => harness.finishPreview(session)
	);
	expect(harness.pending).not.toBeNull();
	const finishing = harness.finishPreview(session);
	expect(releases).toBe(0);
	settle();
	await finishing;
	expect(releases).toBe(1);
	expect(harness.pending).toBeNull();
});

test("a previous hung drain never delays the current recording finish", async () => {
	const retirement = createPreviewRetirement({ debug() {}, safeErrorText: String, setTimeout, clearTimeout });
	retirement.finish = new Promise(() => {});
	const finish = retirement.finishPreview;
	let completed = false;
	void finish({ finish: () => Promise.resolve() }).then(() => {
		completed = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(completed).toBe(true);
});

test("stale generations cannot stop or deliver", async () => {
	let current = true;
	const owner = createRecordingOwner(() => current);
	current = false;
	await owner.stop(
		() => {
			throw new Error("stale stop");
		},
		async () => {}
	);
	expect(owner.deliver()).toBe(false);
});
