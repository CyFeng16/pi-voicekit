import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { startRecordingEntry, type RecordingEntryDeps } from "../extensions/voice/recording-entry";
import { createRecordingController } from "../extensions/voice/recording-controller";
import { createRecordingOwner, resolvePreviewModelDir } from "../extensions/voice/preview-entrypoint";
import { createPreviewClient, type PreviewClient, type PreviewEvent } from "../extensions/voice/preview-worker-client";
import { createPreviewSession } from "../extensions/voice/preview-session";
import { createPreviewRetirement } from "../extensions/voice/preview-retirement";

function entryHarness() {
	const workers: EventEmitter[] = [],
		clients: PreviewClient[] = [],
		events: string[] = [];
	const config = { previewEnabled: true };
	let installed = true;
	const retirement = createPreviewRetirement({
		debug: () => {
			events.push("debug");
		},
		safeErrorText: String,
		setTimeout,
		clearTimeout,
	});
	const controller = createRecordingController({ debug() {} });
	const deps: RecordingEntryDeps<null> = {
		recordingController: controller,
		debug() {},
		setState: (value) => controller.setState(value),
		abortPreview() {},
		setOwner() {},
		getContext: () => null,
		getConfig: () => config,
		resolvePreviewModelDir: (enabled) =>
			resolvePreviewModelDir(
				enabled,
				() => installed,
				() => "model"
			),
		createRecordingOwner,
		createPreviewClient: (options) => {
			events.push(`create:${options.previewModelDir}`);
			const client = createPreviewClient({
				...options,
				spawnWorker: () => {
					const worker = Object.assign(new EventEmitter(), { postMessage() {}, terminate() {} });
					workers.push(worker);
					return worker;
				},
			});
			clients.push(client);
			return client;
		},
		retirePreviewClient: retirement.retirePreviewClient,
		preview: { client: null, modelDir: null, finish: null },
	};
	return {
		deps,
		config,
		workers,
		clients,
		events,
		setInstalled: (value: boolean) => {
			installed = value;
		},
		start: () => startRecordingEntry(deps),
		async dispose() {
			retirement.destroyRetiringClients();
			await Promise.all(clients.map((client) => client.destroy()));
		},
	};
}

for (const transition of ["installed", "enabled", "removed", "disabled"] as const) {
	test(`recording start refreshes preview availability when ${transition}`, async () => {
		const h = entryHarness();
		try {
			h.setInstalled(transition !== "installed");
			h.config.previewEnabled = transition !== "enabled";
			const activating = transition === "installed" || transition === "enabled";
			const first = h.start();
			expect(first.previewModelDir).toBe(activating ? null : "model");
			let destroyed = 0;
			const destroy = first.client.destroy;
			first.client.destroy = async () => {
				destroyed++;
				h.events.push("destroy");
				await destroy();
			};
			h.setInstalled(transition !== "removed");
			h.config.previewEnabled = transition !== "disabled";
			const second = h.start();
			expect(second.previewModelDir).toBe(activating ? "model" : null);
			expect(h.start().client).toBe(second.client);
			expect(destroyed).toBe(1);
			expect(second.client).not.toBe(first.client);
			expect(h.events).toEqual([
				`create:${activating ? null : "model"}`,
				"destroy",
				`create:${activating ? "model" : null}`,
			]);
		} finally {
			await h.dispose();
		}
	});
}

for (const duringStop of [false, true]) {
	test(`cancelled A's ${duringStop ? "stop" : "maintenance"} drain cannot deliver A as B on the same directory`, async () => {
		const h = entryHarness();
		try {
			const a = h.start();
			const channel = a.client.claim(String(a.generation), () => {});
			channel.feed(Buffer.alloc(2));
			h.workers[0]!.emit("message", { type: "ready" });
			const preview = createPreviewSession(channel, { mountPanel() {}, unmountPanel() {}, onDegraded() {} });
			preview.feed(Buffer.alloc(2));
			if (duringStop) void preview.drain();
			preview.abort();
			const b = h.start(),
				events: PreviewEvent[] = [];
			const next = b.client.claim(String(b.generation), (event) => events.push(event));
			next.feed(Buffer.alloc(2));
			expect(h.workers).toHaveLength(2);
			h.workers[1]!.emit("message", { type: "ready" });
			h.workers[0]!.emit("message", { type: "partial", segmentId: 0, revision: 1, text: "A" });
			h.workers[1]!.emit("message", { type: "partial", segmentId: 0, revision: 1, text: "B" });
			expect(events.map((event) => event.text)).toEqual(["B"]);
		} finally {
			await h.dispose();
		}
	});
}

for (const rejected of [false, true]) {
	test(`preview swap immediately claims the replacement but defers destruction until drain ${rejected ? "rejects" : "resolves"}`, async () => {
		const h = entryHarness();
		try {
			const first = h.start();
			let settle!: () => void;
			h.deps.preview.finish = new Promise<void>((resolve, reject) => {
				settle = () => {
					h.events.push("settled");
					if (rejected) reject(new Error("drain failed"));
					else resolve();
				};
			});
			first.client.destroy = async () => {
				h.events.push("destroy");
				throw new Error("destroy failed");
			};
			h.config.previewEnabled = false;
			const next = h.start();
			expect(h.clients).toHaveLength(2);
			expect(next.client).toBe(h.clients[1]!);
			expect(next.client).not.toBe(first.client);
			next.client.claim(String(next.generation), () => {});
			expect(h.events).toEqual(["create:model", "create:null"]);
			settle();
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(h.events.slice(-3)).toEqual(["settled", "destroy", "debug"]);
			first.client.destroy = async () => {};
		} finally {
			await h.dispose();
		}
	});
}
