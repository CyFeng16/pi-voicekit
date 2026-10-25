import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

// Execute the entrypoint's closure wiring without starting a microphone or terminal host.
const entrypointSource = readFileSync(new URL("../extensions/voice.ts", import.meta.url), "utf8");
const transpiler = new Bun.Transpiler({ loader: "ts" });

for (const transition of ["installed", "enabled", "removed", "disabled"] as const) {
	test(`recording start refreshes preview availability when ${transition}`, async () => {
		let installed = transition !== "installed";
		const config = { previewEnabled: transition !== "enabled" };
		const events: string[] = [];
		let live = 0;
		const preamble = entrypointSource.slice(
			entrypointSource.indexOf("\tasync function startRecording():"),
			entrypointSource.indexOf("\t\tlet unsubscribe:")
		);
		const makeStart = new Function(
			"config",
			"resolvePreviewModelDir",
			"createPreviewClient",
			"createRecordingOwner",
			transpiler.transformSync(`
				let previewClient = null;
				let previewClientModelDir: string | null = null;
				let recordingGeneration = 0, recordingOwner = null;
				const activePreview = null, ctx = null;
				const voiceDebug = () => {}, setVoiceState = () => {};
				${preamble}
				return previewClient.claim(String(generation), () => {});
				}
				return startRecording;
			`)
		);
		const start = makeStart(
			config,
			(enabled: boolean) =>
				resolvePreviewModelDir(
					enabled,
					() => installed,
					() => "model"
				),
			({ previewModelDir }: { previewModelDir: string | null }) => {
				expect(++live).toBe(1);
				events.push(`create:${previewModelDir}`);
				return {
					claim: () => previewModelDir,
					destroy: () => {
						live--;
						events.push("destroy");
						return Promise.resolve();
					},
				};
			},
			createRecordingOwner
		);
		const activating = transition === "installed" || transition === "enabled";
		expect(await start()).toBe(activating ? null : "model");
		installed = transition !== "removed";
		config.previewEnabled = transition !== "disabled";
		expect(await start()).toBe(activating ? "model" : null);
		expect(await start()).toBe(activating ? "model" : null);
		expect(events).toEqual([
			`create:${activating ? null : "model"}`,
			"destroy",
			`create:${activating ? "model" : null}`,
		]);
	});
}

for (const superseded of [false, true]) {
	test(`dictate start ${superseded ? "superseded publishes nothing" : "current publishes its notice"}`, async () => {
		const notices: string[] = [];
		let resolve!: (ok: boolean) => void;
		const pending = new Promise<boolean>((r) => {
			resolve = r;
		});
		const body = entrypointSource.slice(
			entrypointSource.indexOf('\t\t\tif (sub === "dictate")'),
			entrypointSource.indexOf("\t\t\t// /voice history")
		);
		const harness = new Function(
			"pending",
			"notices",
			transpiler.transformSync(`
			let recordingGeneration = 0, dictationMode = false;
			const config = { enabled: true }, sub = "dictate", toggleShortcutLabel = "toggle";
			const cmdCtx = { ui: { notify: (text) => notices.push(text) } };
			const startVoiceRecording = () => { recordingGeneration++; return pending; };
			return { run: async () => { ${body} }, supersede: () => recordingGeneration++ };
		`)
		)(pending, notices);
		const running = harness.run();
		if (superseded) harness.supersede();
		resolve(true);
		await running;
		expect(notices).toHaveLength(superseded ? 0 : 1);
	});
}

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
