import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createFinalPassClient } from "../extensions/voice/final-pass-client";
import { startLocalSession, stopLocalSession, abortLocalSession } from "../extensions/voice/local";
import { DEFAULT_CONFIG } from "../extensions/voice/config";
import type { ChildProcess } from "node:child_process";

class FakeWorker extends EventEmitter {
	messages: any[] = [];
	terminated = false;
	postMessage(message: unknown) {
		this.messages.push(message);
	}
	terminate() {
		this.terminated = true;
		return Promise.resolve(0);
	}
}
function harness(timeoutMs = 1000) {
	const workers: FakeWorker[] = [];
	const client = createFinalPassClient({
		timeoutMs,
		spawnWorker: () => {
			const worker = new FakeWorker();
			workers.push(worker);
			return worker;
		},
	});
	return { client, workers };
}
const pcm = Buffer.alloc(3200);

test("unbound final pass rejects without spawning", async () => {
	const { client, workers } = harness();
	await expect(client.transcribe(pcm)).rejects.toThrow();
	expect(workers).toHaveLength(0);
	await client.destroy();
});

test("ready gates audio, requests serialize and the worker stays warm across recordings", async () => {
	const { client, workers } = harness();
	await client.rebind("sensevoice", "/models", "en-US");
	expect(workers).toHaveLength(0);
	const first = client.transcribe(pcm);
	const second = client.transcribe(pcm);
	const worker = workers[0]!;
	expect(worker.messages).toEqual([{ type: "init", modelId: "sensevoice", modelDir: "/models", language: "en" }]);
	worker.emit("message", { type: "ready" });
	expect(worker.messages).toHaveLength(2);
	worker.emit("message", { type: "result", text: "first", hadSpeech: true });
	await expect(first).resolves.toEqual({ text: "first", hadSpeech: true });
	expect(worker.messages).toHaveLength(3);
	worker.emit("message", { type: "result", text: "", hadSpeech: false });
	await expect(second).resolves.toEqual({ text: "", hadSpeech: false });
	await client.rebind("sensevoice", "/models", "en-GB");
	const third = client.transcribe(pcm);
	expect(workers).toHaveLength(1);
	worker.emit("message", { type: "result", text: "warm", hadSpeech: true });
	await expect(third).resolves.toEqual({ text: "warm", hadSpeech: true });
	await client.destroy();
	expect(worker.terminated).toBe(true);
});

for (const mode of ["failed", "error", "exit", "destroy", "timeout"] as const) {
	test(`${mode} rejects active and queued work and allows a fresh worker`, async () => {
		const { client, workers } = harness(mode === "timeout" ? 10 : 1000);
		await client.rebind("sensevoice", "/missing", "en");
		const results = Promise.allSettled([client.transcribe(pcm), client.transcribe(pcm)]);
		const worker = workers[0]!;
		if (mode === "failed") worker.emit("message", { type: "failed", message: "missing model" });
		if (mode === "error") worker.emit("error", new Error("died"));
		if (mode === "exit") worker.emit("exit", 0);
		if (mode === "destroy") await client.destroy();
		expect((await results).map((r) => r.status)).toEqual(["rejected", "rejected"]);
		expect(worker.terminated).toBe(true);
		const next = client.transcribe(pcm);
		worker.emit("message", { type: "result", text: "stale", hadSpeech: true });
		workers[1]!.emit("message", { type: "ready" });
		workers[1]!.emit("message", { type: "result", text: "fresh", hadSpeech: true });
		await expect(next).resolves.toEqual({ text: "fresh", hadSpeech: true });
		await client.destroy();
	});
}

for (const [model, dir, lang] of [
	["whisper", "/models", "en"],
	["sensevoice", "/models", "zh"],
	["sensevoice", "/other", "en"],
]) {
	test(`rebind invalidates pending work for ${model}/${dir}/${lang}`, async () => {
		const { client, workers } = harness();
		await client.rebind("sensevoice", "/models", "en");
		const pending = client.transcribe(pcm);
		const rejected = pending.catch((error: Error) => error);
		await client.rebind(model!, dir!, lang!);
		expect(await rejected).toEqual(expect.objectContaining({ message: expect.stringContaining("rebound") }));
		expect(workers[0]!.terminated).toBe(true);
		const next = client.transcribe(pcm);
		workers[1]!.emit("message", { type: "ready" });
		workers[1]!.emit("message", { type: "result", text: "new", hadSpeech: true });
		await expect(next).resolves.toEqual({ text: "new", hadSpeech: true });
		await client.destroy();
	});
}

test("spawn and post failures reject without escaping the promise", async () => {
	for (const spawnWorker of [
		() => {
			throw new Error("spawn failed");
		},
		() =>
			Object.assign(new FakeWorker(), {
				postMessage() {
					throw new Error("post failed");
				},
			}),
	]) {
		const client = createFinalPassClient({ spawnWorker });
		await client.rebind("sensevoice", "/models", "en");
		await expect(client.transcribe(pcm)).rejects.toThrow("failed");
		await client.destroy();
	}
});

test("segment observers keep order and cannot fail a final pass", async () => {
	const { client, workers } = harness();
	await client.rebind("sensevoice", "/models", "en");
	const segments: string[] = [];
	const result = client.transcribe(pcm, (text, index) => {
		segments.push(`${index}:${text}`);
		throw new Error("observer");
	});
	workers[0]!.emit("message", { type: "ready" });
	workers[0]!.emit("message", { type: "segment", text: "one", index: 0 });
	workers[0]!.emit("message", { type: "segment", text: "two", index: 1 });
	workers[0]!.emit("message", { type: "result", text: "one two", hadSpeech: true });
	await expect(result).resolves.toEqual({ text: "one two", hadSpeech: true });
	expect(segments).toEqual(["0:one", "1:two"]);
	await client.destroy();
});

test("a hung decode after ready still hits the host deadline", async () => {
	const { client, workers } = harness(10);
	await client.rebind("sensevoice", "/models", "en");
	const result = client.transcribe(pcm);
	workers[0]!.emit("message", { type: "ready" });
	await expect(result).rejects.toThrow("Transcription timed out");
	expect(workers[0]!.terminated).toBe(true);
	await client.destroy();
});

for (const outcome of ["result", "failed", "exit", "timeout", "abort"] as const) {
	test(`local stop maps worker ${outcome} through onDone, never onError`, async () => {
		const { client, workers } = harness(outcome === "timeout" ? 10 : 1000);
		await client.rebind("sensevoice", "/models", "en");
		const proc = Object.assign(new EventEmitter(), {
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
			kill: () => true,
		});
		const results: unknown[] = [];
		const errors: string[] = [];
		const session = startLocalSession(proc as unknown as ChildProcess, {
			onDone: (result) => results.push(result),
			onError: (error) => errors.push(error),
		});
		proc.stdout.emit("data", pcm);
		await stopLocalSession(session, { ...DEFAULT_CONFIG, localModel: "unknown-test-model" }, (audio) => {
			const pending = client.transcribe(audio);
			const worker = workers[0]!;
			worker.emit("message", { type: "ready" });
			if (outcome === "result") worker.emit("message", { type: "result", text: "final", hadSpeech: true });
			if (outcome === "failed") worker.emit("message", { type: "failed", message: "decode failed" });
			if (outcome === "exit") worker.emit("exit", 1);
			if (outcome === "abort") {
				abortLocalSession(session);
				worker.emit("error", new Error("died after abort"));
			}
			return pending;
		});
		expect(errors).toEqual([]);
		if (outcome === "result") expect(results).toEqual([{ kind: "ok", text: "final", hadSpeech: true }]);
		else if (outcome === "abort") expect(results).toEqual([{ kind: "ok", text: "", hadSpeech: false }]);
		else
			expect(results).toEqual([
				{
					kind: "failed",
					message: expect.stringContaining(
						outcome === "timeout" ? "timed out" : outcome === "exit" ? "exited" : "decode failed"
					),
				},
			]);
		await client.destroy();
	});
}

test("only the worker entry calls the offline recogniser", () => {
	const sources = Object.fromEntries(
		["voice/local.ts", "voice.ts"].map((file) => [
			file,
			readFileSync(new URL(`../extensions/${file}`, import.meta.url), "utf8"),
		])
	);
	expect(sources["voice/local.ts"] ?? "").not.toMatch(/new sherpa\.OfflineRecognizer|getOrCreateRecognizer\(/);
	expect(sources["voice.ts"] ?? "").not.toMatch(/new sherpa\.OfflineRecognizer|getOrCreateRecognizer\(/);
});

test("real worker reports a missing model without crashing the host", async () => {
	const client = createFinalPassClient({ timeoutMs: 10000 });
	await client.rebind("sensevoice-small", "/nonexistent/voicekit-model", "en");
	try {
		await expect(client.transcribe(pcm)).rejects.toThrow("Missing model file");
	} finally {
		await client.destroy();
	}
});

test.skipIf(!process.env.VOICEKIT_FINAL_MODEL_DIR)(
	"real final worker matches the in-process segmented transcript",
	async () => {
		const { LOCAL_MODELS, DEFAULT_LOCAL_MODEL } = await import("../extensions/voice/local");
		const { initSherpa, getOrCreateRecognizer, transcribeBufferSegmented, clearRecognizerCache } = await import(
			"../extensions/voice/sherpa-engine"
		);
		const model = LOCAL_MODELS.find((m) => m.id === (process.env.VOICEKIT_FINAL_MODEL_ID || DEFAULT_LOCAL_MODEL))!;
		const modelDir = process.env.VOICEKIT_FINAL_MODEL_DIR!;
		const audio = process.env.VOICEKIT_FINAL_PCM ? readFileSync(process.env.VOICEKIT_FINAL_PCM) : pcm;
		const client = createFinalPassClient({});
		try {
			await initSherpa();
			const expected = await transcribeBufferSegmented(audio, getOrCreateRecognizer(model, modelDir, "en"));
			await client.rebind(model.id, modelDir, "en");
			await expect(client.transcribe(audio)).resolves.toEqual({
				text: expected,
				hadSpeech: expected.trim().length > 0,
			});
		} finally {
			await client.destroy();
			clearRecognizerCache();
		}
	}
);
