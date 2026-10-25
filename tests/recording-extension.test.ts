import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as os from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import voiceExtension from "../extensions/voice";
import * as local from "../extensions/voice/local";

async function extensionHarness() {
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
				previewEnabled: false,
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
	} finally {
		await h.dispose();
	}
});
