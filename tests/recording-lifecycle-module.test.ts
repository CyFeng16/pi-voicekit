import { expect, test } from "bun:test";
import { lifecycleHarness } from "./recording-lifecycle-harness";
import { stopLocalSession } from "../extensions/voice/local";
import { DEFAULT_CONFIG } from "../extensions/voice/config";

// Re-homed callback-slice assertions: the real lifecycle installs these callbacks on the real session.
for (const captureFailure of [false, true]) {
	test(
		captureFailure
			? "unexpected capture close writes neither editor nor history"
			: "final delivery unmounts before insertion and rejects late partials",
		async () => {
			const h = lifecycleHarness();
			try {
				await h.lifecycle.startRecording();
				const preview = h.state.activePreview!;
				const fed: Buffer[] = [];
				const feed = preview.feed;
				preview.feed = (chunk) => {
					fed.push(chunk);
					feed(chunk);
				};
				const mounted = () => h.events.filter((e) => e.startsWith("panel:")).at(-1) === "panel:mount";
				const first = Buffer.from([1, 0]),
					tail = Buffer.from([2, 0]);
				h.feed(first);
				h.partial("preview");
				expect(mounted()).toBe(true);
				const paste = h.state.ctx!.ui.pasteToEditor;
				h.state.ctx!.ui.pasteToEditor = (text) => {
					if (!captureFailure) expect(mounted()).toBe(false);
					paste(text);
				};
				if (captureFailure) h.process.emit("close", 1, null);
				else {
					const stopping = stopLocalSession(h.state.activeSession!, DEFAULT_CONFIG, async () => ({
						text: "final",
						hadSpeech: true,
					}));
					void preview.drain();
					h.feed(tail);
					await stopping;
					expect(fed).toEqual([first, tail]);
				}
				expect(h.writes).toEqual(captureFailure ? [] : ["final"]);
				expect(h.history).toEqual(captureFailure ? [] : ["final"]);
				expect(h.notices).toHaveLength(1);
				if (captureFailure) expect(h.notices[0]).toContain("Voice error: Audio capture stopped unexpectedly");
				expect(mounted()).toBe(false);
				expect(h.events.filter((e) => e === "panel:unmount")).toHaveLength(1);
				h.partial("late", 2);
				expect(preview.text).toBe("preview");
				expect(mounted()).toBe(false);
			} finally {
				h.dispose();
			}
		}
	);
}

// Awaiting drain before the final pass would leave this test pending.
test("the final result never waits on the preview drain", async () => {
	const h = lifecycleHarness();
	try {
		await h.lifecycle.startRecording();
		h.feed();
		h.partial("preview");
		await h.lifecycle.stopVoiceRecording();
		expect(h.writes).toEqual(["final"]);
		expect(h.flushes()).toBe(1);
	} finally {
		h.dispose();
	}
});

test("the panel is unmounted before the editor write", async () => {
	const h = lifecycleHarness();
	try {
		await h.lifecycle.startRecording();
		h.feed();
		h.partial("preview");
		await h.lifecycle.stopVoiceRecording();
		expect(h.events.filter((e) => ["panel:mount", "panel:unmount", "insert"].includes(e))).toEqual([
			"panel:mount",
			"panel:unmount",
			"insert",
		]);
		h.partial("late", 2);
		expect(h.state.activePreview?.text).toBe("preview");
		expect(h.events.filter((e) => e === "panel:unmount")).toHaveLength(1);
	} finally {
		h.dispose();
	}
});

for (const failed of [false, true]) {
	test(`only final writes history; unconfirmed writes the editor only (${failed ? "unconfirmed" : "final"})`, async () => {
		const h = lifecycleHarness({ failed });
		try {
			await h.lifecycle.startRecording();
			h.feed();
			h.partial("preview");
			await h.lifecycle.stopVoiceRecording();
			expect(h.writes).toEqual([failed ? "preview" : "final"]);
			expect(h.history).toEqual(failed ? [] : ["final"]);
			expect(h.notices).toHaveLength(2);
			expect(h.events.filter((e) => e.startsWith("sound:"))).toEqual(["sound:start", "sound:stop"]);
		} finally {
			h.dispose();
		}
	});
}

test("an unexpected capture close takes the error path, not unconfirmed", async () => {
	const h = lifecycleHarness();
	try {
		await h.lifecycle.startRecording();
		h.feed();
		h.partial("preview");
		h.process.emit("close", 1, null);
		expect(h.writes).toEqual([]);
		expect(h.history).toEqual([]);
		expect(h.notices).toHaveLength(1);
		expect(h.notices[0]).toContain("Voice error: Audio capture stopped unexpectedly");
		expect(h.events.filter((e) => e.startsWith("sound:"))).toEqual(["sound:start", "sound:error"]);
		expect(h.events.filter((e) => e === "panel:unmount")).toHaveLength(1);
		h.partial("late", 2);
		expect(h.state.activePreview?.text).toBe("preview");
		expect(h.controller.state).toBe("idle");
	} finally {
		h.dispose();
	}
});

test("a missing preview model is silent: no panel, no notify, no degradation", async () => {
	const h = lifecycleHarness({ missing: true });
	try {
		await h.lifecycle.startRecording();
		h.feed();
		expect(h.events.some((e) => e.startsWith("panel:"))).toBe(false);
		expect(h.notices).toEqual([]);
		expect(h.state.activePreview?.degraded).toBeNull();
		expect(h.workers).toHaveLength(0);
		await h.lifecycle.stopVoiceRecording();
		expect(h.writes).toEqual(["final"]);
		expect(h.notices).toHaveLength(2);
		expect(h.events.some((e) => e.startsWith("panel:"))).toBe(false);
		expect(h.state.activePreview?.degraded).toBeNull();
	} finally {
		h.dispose();
	}
});
