import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as os from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import voiceExtension, { resetCaptureToolProbeCache } from "../extensions/voice";
import * as local from "../extensions/voice/local";
import * as previewWorker from "../extensions/voice/preview-worker-client";

async function extensionHarness(previewEnabled = false) {
	const home = mkdtempSync(join(os.tmpdir(), "voice-recording-extension-"));
	const previousAgent = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(home, "agent");
	mkdirSync(join(home, "agent"));
	writeFileSync(
		join(home, "agent", "settings.json"),
		JSON.stringify({
			voice: {
				enabled: true,
				localModel: "paraformer-zh",
				previewEnabled,
				punctuationEnabled: false,
				punctuationNoticeShown: true,
				audioFeedback: false,
				onboarding: { completed: true },
			},
		})
	);
	const homeSpy = spyOn(os, "homedir").mockReturnValue(home);
	const probes = spyOn(childProcess, "spawnSync").mockReturnValue({
		status: 0,
		pid: 1,
		output: [],
		stdout: Buffer.alloc(0),
		stderr: Buffer.alloc(0),
		signal: null,
	});
	// The probe memo is process-wide, so clear it once the spy is in place; otherwise a preceding
	// test file fixes the answer and this harness observes the real machine instead of the spy.
	resetCaptureToolProbeCache();
	let kills = 0;
	const captures: Array<EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean }> = [];
	const spawn = spyOn(childProcess, "spawn").mockImplementation((() => {
		const capture = Object.assign(new EventEmitter(), {
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
			kill: () => {
				kills++;
				return true;
			},
		});
		captures.push(capture);
		return capture;
	}) as unknown as typeof childProcess.spawn);
	const realStop = local.stopLocalSession;
	let finish!: (value: { text: string; hadSpeech: boolean }) => void;
	let entered!: () => void;
	const finalEntered = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const final = new Promise<{ text: string; hadSpeech: boolean }>((resolve) => {
		finish = resolve;
	});
	let passes = 0;
	const stop = spyOn(local, "stopLocalSession").mockImplementation((session, config) =>
		realStop(session, config, async () => {
			passes++;
			entered();
			return final;
		})
	);
	const notices: string[] = [],
		writes: string[] = [],
		sends: unknown[] = [];
	let buffer = "typed|suffix";
	const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const shortcuts: Array<{ handler: (ctx: any) => Promise<void> }> = [];
	let input!: (data: string) => unknown;
	const ctx = {
		cwd: home,
		hasUI: true,
		ui: {
			notify: (text: string) => notices.push(text),
			setStatus() {},
			setWidget() {},
			getEditorText: () => buffer,
			pasteToEditor: (text: string) => {
				writes.push(text);
				buffer = buffer.replace("|", text + "|");
			},
			setEditorText: () => {
				throw new Error("must not replace editor");
			},
			onTerminalInput: (handler: (data: string) => unknown) => {
				input = handler;
				return () => {};
			},
		},
	};
	voiceExtension({
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerShortcut: (_key: string, shortcut: any) => shortcuts.push(shortcut),
		sendUserMessage: (...args: unknown[]) => sends.push(args),
	} as unknown as ExtensionAPI);
	const shutdown = () => handlers.get("session_shutdown")!({}, ctx);
	const dispose = async () => {
		try {
			await shutdown();
		} finally {
			resetCaptureToolProbeCache();
			stop.mockRestore();
			spawn.mockRestore();
			probes.mockRestore();
			homeSpy.mockRestore();
			if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgent;
			rmSync(home, { recursive: true, force: true });
		}
	};
	try {
		await handlers.get("session_start")!({ reason: "startup" }, ctx);
	} catch (error) {
		await dispose();
		throw error;
	}
	notices.length = 0;
	return {
		notices,
		writes,
		sends,
		captures,
		finalEntered,
		shutdown,
		dispose,
		run: (args: string) => commands.get("voice")!.handler(args, ctx),
		toggle: () => shortcuts[0]!.handler(ctx),
		cancel: () => input("\x1b"),
		feed: () => captures.at(-1)!.stdout.emit("data", Buffer.from([1, 0])),
		finish: () => finish({ text: "final", hadSpeech: true }),
		get passes() {
			return passes;
		},
		get kills() {
			return kills;
		},
		get buffer() {
			return buffer;
		},
	};
}

for (const superseded of [false, true]) {
	test(`real dictate start ${superseded ? "superseded publishes nothing and leaves dictation off" : "publishes one notice and enables dictation"}`, async () => {
		const h = await extensionHarness();
		try {
			const pending = h.run("dictate");
			// The lifecycle has started synchronously, but the command has not resumed its await.
			if (superseded) h.cancel();
			await pending;
			expect(h.notices).toHaveLength(superseded ? 0 : 1);
			if (!superseded) expect(h.notices[0]).toContain("Continuous dictation mode active.");
			h.notices.length = 0;
			await h.run("dictate");
			expect(h.notices).toHaveLength(1);
			expect(h.notices[0]).toContain(superseded ? "Continuous dictation mode active." : "Already in dictation mode.");
			expect(h.writes).toEqual([]);
			expect(h.sends).toEqual([]);
		} finally {
			await h.dispose();
		}
	});
}

test("session cleanup cancels an in-flight guarded start and delivers nothing", async () => {
	const h = await extensionHarness();
	try {
		await h.toggle();
		const pending = h.run("dictate");
		await h.shutdown();
		await pending;
		expect(h.captures).toHaveLength(1);
		expect(h.kills).toBeGreaterThan(0);
		expect(h.notices).toEqual([]);
		expect(h.writes).toEqual([]);
		expect(h.sends).toEqual([]);
	} finally {
		await h.dispose();
	}
});

test("session cleanup destroys live and retired preview clients, cancels retirement and ignores late drain", async () => {
	const realCreate = previewWorker.createPreviewClient;
	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	const retirementTimers = new Set<ReturnType<typeof setTimeout>>();
	const workers: Array<EventEmitter & { terminations: number }> = [];
	const clients: previewWorker.PreviewClient[] = [];
	const destroys: number[] = [];
	const schedule = spyOn(globalThis, "setTimeout").mockImplementation(
		Object.assign((...args: Parameters<typeof setTimeout>) => {
			const timer = realSetTimeout(...args);
			if (args[1] === 60_250) retirementTimers.add(timer);
			return timer;
		}, realSetTimeout)
	);
	const clear = spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
		retirementTimers.delete(timer as ReturnType<typeof setTimeout>);
		realClearTimeout(timer as ReturnType<typeof setTimeout>);
	});
	// Keep the client, entry, lifecycle and retirement real; replace only the model worker boundary.
	const create = spyOn(previewWorker, "createPreviewClient").mockImplementation((options) => {
		const index = clients.length;
		const client = realCreate({
			...options,
			previewModelDir: "/test-preview-model",
			flushTimeoutMs: 60_000,
			spawnWorker: () => {
				const worker = Object.assign(new EventEmitter(), {
					terminations: 0,
					postMessage() {},
					terminate() {
						worker.terminations++;
					},
				});
				workers.push(worker);
				return worker;
			},
		});
		const destroy = client.destroy;
		destroys.push(0);
		client.destroy = () => {
			destroys[index] = destroys[index]! + 1;
			return destroy();
		};
		clients.push(client);
		return client;
	});
	let h: Awaited<ReturnType<typeof extensionHarness>> | undefined;
	try {
		h = await extensionHarness(true);
		await h.toggle();
		h.feed();
		workers[0]!.emit("message", { type: "ready" });
		h.cancel();
		const drain = clients[0]!.pendingDrain;
		expect(drain).not.toBeNull();
		let drained = false;
		void drain!.then(() => {
			drained = true;
		});
		await h.toggle();
		h.feed();
		workers[1]!.emit("message", { type: "ready" });
		expect(clients).toHaveLength(2);
		expect(drained).toBe(false);
		expect(retirementTimers.size).toBe(1);
		expect(destroys).toEqual([0, 0]);
		const shutdown = h.shutdown();
		expect(destroys).toEqual([1, 1]);
		expect(retirementTimers.size).toBe(0);
		await shutdown;
		await drain;
		workers[0]!.emit("message", { type: "flushed", requestId: 1 });
		await h.shutdown();
		expect(drained).toBe(true);
		expect(destroys).toEqual([1, 1]);
		expect(workers.map((worker) => worker.terminations)).toEqual([1, 1]);
	} finally {
		try {
			await h?.dispose();
			for (const client of clients) await client.destroy();
			for (const timer of retirementTimers) realClearTimeout(timer);
		} finally {
			create.mockRestore();
			clear.mockRestore();
			schedule.mockRestore();
		}
	}
});

for (const phase of ["capture", "finalizing"] as const) {
	test(`real Escape cancels ${phase} without editor delivery or history`, async () => {
		const h = await extensionHarness();
		try {
			await h.toggle();
			h.feed();
			const stopping = phase === "finalizing" ? h.toggle() : Promise.resolve();
			if (phase === "finalizing") await h.finalEntered;
			h.cancel();
			h.finish();
			await stopping;
			expect(h.writes).toEqual([]);
			expect(h.sends).toEqual([]);
			h.notices.length = 0;
			await h.run("history");
			expect(h.notices).toEqual(["No recording history yet."]);
			// Only idle lets the real shortcut start a fresh capture; finalizing ignores it.
			const passes = h.passes;
			await h.toggle();
			expect(h.captures).toHaveLength(2);
			expect(h.passes).toBe(passes);
			h.feed();
			await h.run("stop");
			expect(h.captures).toHaveLength(2);
			expect(h.passes).toBe(passes + 1);
			expect(h.writes).toEqual(["final"]);
		} finally {
			await h.dispose();
		}
	});
}

test("real command final inserts once at the cursor and enters history without auto-send", async () => {
	const h = await extensionHarness();
	try {
		await h.run("dictate");
		h.feed();
		const stopping = h.run("stop");
		await h.finalEntered;
		h.finish();
		await stopping;
		expect(h.writes).toEqual(["final"]);
		expect(h.buffer).toBe("typedfinal|suffix");
		expect(h.sends).toEqual([]);
		expect(h.passes).toBe(1);
		h.notices.length = 0;
		await h.run("history");
		expect(h.notices.join("\n")).toContain("final");
	} finally {
		await h.dispose();
	}
});

test("a second real start while finalizing cancels the first before capture replacement", async () => {
	const h = await extensionHarness();
	try {
		await h.toggle();
		h.feed();
		const stopping = h.toggle();
		await h.finalEntered;
		const starting = h.run("dictate");
		expect(h.captures).toHaveLength(1);
		expect(h.kills).toBeGreaterThan(0);
		await starting;
		expect(h.captures).toHaveLength(2);
		h.finish();
		await stopping;
		expect(h.writes).toEqual([]);
		expect(h.sends).toEqual([]);
		h.notices.length = 0;
		await h.run("history");
		expect(h.notices).toEqual(["No recording history yet."]);
		// A stale completion must not set the newer recording to idle: stop must consume it.
		h.feed();
		await h.run("stop");
		expect(h.captures).toHaveLength(2);
		expect(h.passes).toBe(2);
		expect(h.writes).toEqual(["final"]);
		expect(h.sends).toEqual([]);
	} finally {
		await h.dispose();
	}
});
