import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
	abortLocalSession,
	startLocalSession,
	stopLocalSession,
	type LocalSession,
	type LocalSessionResult,
} from "../extensions/voice/local";
import { DEFAULT_CONFIG, type VoiceConfig } from "../extensions/voice/config";

/**
 * Capture fan-out and the session's single terminal (spec §5.1).
 *
 * `extensions/voice/local.ts` owns one recording's outcome. The preview needs the same samples the
 * final pass will transcribe (`onAudioChunk`), and a recording must settle exactly once no matter
 * how many capture events arrive — that single settle is what lets `failed` (rather than `onError`)
 * carry a final pass that could not finish, so the words the user already saw can still be kept.
 *
 * The child process is faked down to its event surface. No recogniser is loaded here: every terminal
 * that matters is decided before or after the decode, and the one test that does reach the decode
 * uses a model id that does not exist, which fails inside the final pass without touching a model
 * file or the network.
 */

/** A child process with just the surface `local.ts` subscribes to, plus the signals it was sent. */
function fakeRecProcess(): { proc: ChildProcess; stdout: EventEmitter; kills: string[] } {
	const proc = new EventEmitter() as unknown as ChildProcess;
	const kills: string[] = [];
	const streams = proc as unknown as {
		stdout: EventEmitter;
		stderr: EventEmitter;
		kill: (signal: string) => boolean;
	};
	streams.stdout = new EventEmitter();
	streams.stderr = new EventEmitter();
	streams.kill = (signal: string) => {
		kills.push(signal);
		return true;
	};
	return { proc, stdout: streams.stdout, kills };
}

/** A config whose final pass fails on an unknown model id — never on a download or the network. */
const UNKNOWN_MODEL_CONFIG: VoiceConfig = { ...DEFAULT_CONFIG, localModel: "voicekit-test-model-that-does-not-exist" };

/** One captured chunk: 16 kHz mono 16-bit, so 32 bytes per millisecond. */
function audio(ms: number): Buffer {
	return Buffer.alloc(32 * ms);
}

/** Records every terminal callback a session delivered, in order. */
function collectTerminals() {
	const results: Array<{ result: LocalSessionResult; meta: { hadAudio: boolean } }> = [];
	const errors: string[] = [];
	return {
		results,
		errors,
		callbacks: {
			onDone: (result: LocalSessionResult, meta: { hadAudio: boolean }) => {
				results.push({ result, meta });
			},
			onError: (err: string) => {
				errors.push(err);
			},
		},
	};
}

describe("onAudioChunk fan-out", () => {
	test("every captured chunk is offered to onAudioChunk and still buffered", () => {
		const media = fakeRecProcess();
		const seen: Buffer[] = [];
		const bufferedWhenCalled: number[] = [];
		let session: LocalSession | undefined;

		session = startLocalSession(media.proc, {
			onDone() {},
			onError() {},
			onAudioChunk(chunk) {
				seen.push(chunk);
				// Fan-out happens before buffering, so the chunk being offered is not in the buffer yet.
				bufferedWhenCalled.push(session?.audioChunks.length ?? -1);
			},
		});

		const first = audio(20);
		const second = audio(20);
		media.stdout.emit("data", first);
		media.stdout.emit("data", second);

		// In order, same objects, and ahead of the buffer by exactly one call each.
		expect(seen).toEqual([first, second]);
		expect(seen[0]).toBe(first);
		expect(bufferedWhenCalled).toEqual([0, 1]);

		// Capture is not diverted into the preview: the final pass still owns every sample.
		expect(session.audioChunks).toEqual([first, second]);
		expect(session.hadAudioData).toBe(true);
	});

	test("without a callback capture behaves exactly as before", () => {
		const media = fakeRecProcess();
		const terminal = collectTerminals();
		const session = startLocalSession(media.proc, terminal.callbacks);

		media.stdout.emit("data", audio(20));

		expect(session.onAudioChunk).toBeUndefined();
		expect(session.audioChunks).toHaveLength(1);
		expect(terminal.results).toHaveLength(0);
	});

	test("a throwing onAudioChunk does not break capture", async () => {
		const media = fakeRecProcess();
		const terminal = collectTerminals();
		let calls = 0;

		const session = startLocalSession(media.proc, {
			...terminal.callbacks,
			onAudioChunk() {
				calls += 1;
				throw new Error("preview exploded");
			},
		});

		media.stdout.emit("data", audio(20));
		media.stdout.emit("data", audio(20));

		// Capture survived both throws: the chunks are buffered and the observer is still subscribed.
		expect(calls).toBe(2);
		expect(session.audioChunks).toHaveLength(2);
		expect(session.audioChunks[0]!.length + session.audioChunks[1]!.length).toBe(audio(20).length * 2);

		// And the session still reaches exactly one terminal through onDone, not onError.
		await stopLocalSession(session, UNKNOWN_MODEL_CONFIG);
		expect(terminal.errors).toEqual([]);
		expect(terminal.results).toHaveLength(1);
		expect(terminal.results[0]!.result.kind).toBe("failed");
	});
});

describe("a final pass failure is a recording outcome", () => {
	test("a final pass that cannot finish settles onDone as failed, never as onError", async () => {
		const media = fakeRecProcess();
		const terminal = collectTerminals();
		const session = startLocalSession(media.proc, terminal.callbacks);

		media.stdout.emit("data", audio(20));
		await stopLocalSession(session, UNKNOWN_MODEL_CONFIG);

		expect(terminal.errors).toEqual([]);
		expect(terminal.results).toHaveLength(1);
		expect(terminal.results[0]!.result).toEqual({
			kind: "failed",
			message: expect.stringContaining("Local transcription failed"),
		});
		expect(terminal.results[0]!.meta).toEqual({ hadAudio: true });
	});

	test("a stop that captured nothing settles ok with no speech", async () => {
		const media = fakeRecProcess();
		const terminal = collectTerminals();
		const session = startLocalSession(media.proc, terminal.callbacks);

		await stopLocalSession(session, UNKNOWN_MODEL_CONFIG);

		expect(terminal.errors).toEqual([]);
		expect(terminal.results).toHaveLength(1);
		expect(terminal.results[0]).toEqual({
			result: { kind: "ok", text: "", hadSpeech: false },
			meta: { hadAudio: false },
		});
	});

	test("a second stop after the first outcome writes nothing and settles nothing", async () => {
		const media = fakeRecProcess();
		const terminal = collectTerminals();
		const session = startLocalSession(media.proc, terminal.callbacks);

		media.stdout.emit("data", audio(20));
		await stopLocalSession(session, UNKNOWN_MODEL_CONFIG);
		await stopLocalSession(session, UNKNOWN_MODEL_CONFIG);

		expect(terminal.results).toHaveLength(1);
		expect(terminal.errors).toEqual([]);
	});
});

describe("an unexpected capture close terminates the recording", () => {
	test("an unexpected close settles the session exactly once through onDone", () => {
		const media = fakeRecProcess();
		const terminal = collectTerminals();
		const session = startLocalSession(media.proc, terminal.callbacks);

		media.stdout.emit("data", audio(20));
		media.proc.emit("close", 1, null);
		// Both events can arrive for one exit; the session must not settle twice.
		media.proc.emit("close", 1, null);
		media.proc.emit("exit", 1, null);

		expect(terminal.errors).toEqual([]);
		expect(terminal.results).toHaveLength(1);
		expect(terminal.results[0]!.result).toEqual({
			kind: "failed",
			message: expect.stringContaining("Audio capture stopped unexpectedly"),
		});
		// The words captured before the crash are still accounted for.
		expect(terminal.results[0]!.meta).toEqual({ hadAudio: true });
		// Capture is stopped: later audio neither buffers nor reaches the preview.
		const observed: Buffer[] = [];
		session.onAudioChunk = (chunk) => observed.push(chunk);
		media.stdout.emit("data", audio(20));
		expect(observed).toEqual([]);
		expect(session.audioChunks).toHaveLength(1);
	});

	test("a paired error and close produce one terminal, not two", () => {
		const media = fakeRecProcess();
		const terminal = collectTerminals();
		startLocalSession(media.proc, terminal.callbacks);

		media.proc.emit("error", new Error("spawn sox ENOENT"));
		media.proc.emit("close", 1, null);

		// A capture error is not a recording outcome: it keeps onError, and the close it implies is
		// expected rather than a second terminal.
		expect(terminal.errors).toEqual([expect.stringContaining("Audio capture error: spawn sox ENOENT")]);
		expect(terminal.results).toEqual([]);
	});

	test("a stop in flight owns the outcome; the close it causes is expected", async () => {
		const media = fakeRecProcess();
		const terminal = collectTerminals();
		const session = startLocalSession(media.proc, terminal.callbacks);

		media.stdout.emit("data", audio(20));
		const stopping = stopLocalSession(session, UNKNOWN_MODEL_CONFIG);
		// SIGTERM makes the child exit while the stop is still draining: that close is the stop's own.
		media.proc.emit("close", null, "SIGTERM");
		media.proc.emit("exit", null, "SIGTERM");
		await stopping;

		expect(media.kills).toEqual(["SIGTERM"]);
		expect(terminal.errors).toEqual([]);
		expect(terminal.results).toHaveLength(1);
		expect(terminal.results[0]!.result.kind).toBe("failed");
		expect(terminal.results[0]!.result).not.toEqual(
			expect.objectContaining({ message: expect.stringContaining("unexpectedly") })
		);
	});

	test("a stop after an unexpected close does not settle a second time", async () => {
		const media = fakeRecProcess();
		const terminal = collectTerminals();
		const session = startLocalSession(media.proc, terminal.callbacks);

		media.stdout.emit("data", audio(20));
		media.proc.emit("close", 1, null);
		await stopLocalSession(session, UNKNOWN_MODEL_CONFIG);

		expect(terminal.errors).toEqual([]);
		expect(terminal.results).toHaveLength(1);
		expect(terminal.results[0]!.result.kind).toBe("failed");
	});

	test("an abort is expected: its close settles nothing", () => {
		const media = fakeRecProcess();
		const terminal = collectTerminals();
		const session = startLocalSession(media.proc, terminal.callbacks);

		media.stdout.emit("data", audio(20));
		abortLocalSession(session);
		media.proc.emit("close", null, "SIGKILL");

		expect(media.kills).toEqual(["SIGKILL"]);
		expect(terminal.errors).toEqual([]);
		expect(terminal.results).toEqual([]);
	});
});
