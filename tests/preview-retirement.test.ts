import { expect, test } from "bun:test";
import { createPreviewRetirement } from "../extensions/voice/preview-retirement.ts";
import { createRecordingOwner } from "../extensions/voice/preview-entrypoint.ts";
import { createPreviewSession } from "../extensions/voice/preview-session.ts";

const deps = { debug() {}, safeErrorText: String, setTimeout, clearTimeout };

test("a superseded recording cannot deliver after its retired drain settles", async () => {
	const retirement = createPreviewRetirement(deps);
	let current = true;
	let settle!: () => void;
	let destroyed = 0;
	let released = 0;
	const owner = createRecordingOwner(() => current);
	const session = createPreviewSession(
		{
			recordingId: "old",
			feed() {},
			flush: () =>
				new Promise<void>((resolve) => {
					settle = resolve;
				}),
			release() {
				released++;
			},
			destroy: async () => {},
		},
		{ mountPanel() {}, unmountPanel() {}, onDegraded() {} }
	);
	await owner.stop(
		async () => {},
		() => retirement.finishPreview(session)
	);
	const drain = retirement.finish;
	expect(drain).not.toBeNull();
	current = false;
	owner.cancel();
	session.abort();
	retirement.retirePreviewClient(
		{
			flushTimeoutMs: 25,
			destroy: async () => {
				destroyed++;
			},
		},
		drain
	);
	expect(destroyed).toBe(0);
	settle();
	await drain;
	expect(owner.deliver()).toBe(false);
	expect(released).toBe(1);
	expect(destroyed).toBe(1);
});

test("only the newest finish may clear the pending slot", async () => {
	const retirement = createPreviewRetirement(deps);
	let releaseOld!: () => void;
	let releaseNew!: () => void;
	const old = retirement.finishPreview({
		finish: () =>
			new Promise<void>((r) => {
				releaseOld = r;
			}),
	});
	const newest = retirement.finishPreview({
		finish: () =>
			new Promise<void>((r) => {
				releaseNew = r;
			}),
	});
	expect(retirement.finish).toBe(newest);
	releaseOld();
	await old;
	expect(retirement.finish).toBe(newest);
	releaseNew();
	await newest;
	expect(retirement.finish).toBeNull();
});

test("retirement destroys a hung drain at exactly the flush budget plus 250ms", async () => {
	let expire!: () => void;
	const delays: number[] = [];
	const events: string[] = [];
	const retirement = createPreviewRetirement({
		...deps,
		setTimeout: (callback, delay) => {
			expire = callback;
			delays.push(delay);
			return {
				unref() {
					events.push("unref");
				},
			};
		},
		clearTimeout: () => {
			events.push("clear");
		},
	});
	retirement.retirePreviewClient(
		{
			flushTimeoutMs: 25,
			destroy: async () => {
				events.push("destroy");
			},
		},
		new Promise(() => {})
	);
	expect(delays).toEqual([275]);
	expect(events).toEqual(["unref"]);
	expire();
	expire();
	retirement.destroyRetiringClients();
	expect(events).toEqual(["unref", "clear", "destroy"]);
});

test("finish rejection is logged and releases the newest slot", async () => {
	const messages: unknown[] = [];
	const retirement = createPreviewRetirement({
		...deps,
		debug: (...args) => {
			messages.push(args);
		},
	});
	await retirement.finishPreview({
		finish: async () => {
			throw new Error("failed");
		},
	});
	expect(retirement.finish).toBeNull();
	expect(messages).toEqual([["preview finish failed", { error: "Error: failed" }]]);
});
