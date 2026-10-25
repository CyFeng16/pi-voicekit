/**
 * The preview worker entry: it owns the streaming recogniser, so no decode ever runs on the UI thread.
 *
 * Spec: docs/superpowers/specs/2026-10-22-local-streaming-preview-design.md §4.2, §5.2, §5.3.
 *
 * Why a worker at all: an in-thread decode costs one to two frames every ~1.3 s and constructing the
 * model freezes the caller for ~0.6 s (§3.5), so the recogniser is built and driven here and the main
 * thread only reads partials. The addon is CommonJS, hence `createRequire`: a static ESM import of it is
 * not resolvable under Node's loader, and a `.ts` worker entry is run with type stripping rather than
 * bundled.
 *
 * The relative imports carry their `.ts` extension on purpose. A worker thread is loaded by the runtime's
 * own ESM resolver — the host's TypeScript loader (jiti) is not installed in it — and Node resolves only
 * specifiers that name a file, so `./preview-stream` would fail with `ERR_MODULE_NOT_FOUND` there while
 * the rest of the extension, which jiti resolves, keeps working.
 *
 * Segmentation, the 60 s cap and the tail drain belong to `preview-stream`; this module only maps the
 * protocol onto it. It never invents a `cap` boundary — the cap is the module's, and a boundary raised
 * from outside would end the successor segment the moment it was born.
 *
 * Failure is one message, never a crash: a model that will not load, or a decode that throws, posts a
 * single `failed` and ends the thread with code 0, so the client sees a structured degradation instead of
 * a worker that died with no detail. Audio sent before `ready` is dropped — the client awaits `ready`
 * before it feeds, and there is no queue to replay it from.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { parentPort, type MessagePort } from "node:worker_threads";
import { previewModel } from "./local.ts";
import { createPreviewStream, type OnlineRecognizerLike, type PreviewStreamEvent } from "./preview-stream.ts";

/** Everything the main thread may send this worker. */
export type WorkerRequest =
	| { type: "init"; modelDir: string }
	| { type: "feed"; samples: Float32Array }
	| { type: "flush"; reason: "pause" | "cap" | "stop"; requestId: number }
	| { type: "dispose" };

/** Everything this worker may answer, one message per request except for the unsolicited events. */
export type WorkerResponse =
	| { type: "ready" }
	| { type: "partial"; segmentId: number; revision: number; text: string }
	| { type: "commit"; segmentId: number; text: string }
	| { type: "flushed"; requestId: number }
	| { type: "failed"; message: string };

/** The capture child's PCM format, which is also what the preview model was trained on. */
const SAMPLE_RATE = 16_000;
/** Spec §5.3's hard cap per segment. A boundary, never a truncation: the ring buffer keeps everything. */
const SEGMENT_CAP_MS = 60_000;
/** Spec §5.3's tail silence, fed before `inputFinished()` so a boundary does not drop its last words. */
const TAIL_SILENCE_MS = 400;

type PreviewStream = ReturnType<typeof createPreviewStream>;

function startPreviewWorker(port: MessagePort): void {
	/** The recording's segmenter; `null` until `init` has built a recogniser. */
	let stream: PreviewStream | null = null;

	function send(response: WorkerResponse): void {
		port.postMessage(response);
	}

	/**
	 * Report the failure and end the thread: nothing this worker could answer afterwards would be true.
	 * Callers must `return` it rather than call it and carry on — under Bun `process.exit()` does not stop
	 * the current synchronous run, so the next statement would still execute.
	 */
	function fail(error: unknown): never {
		send({ type: "failed", message: error instanceof Error ? error.message : String(error) });
		process.exit(0);
	}

	function init(modelDir: string): void {
		let created: PreviewStream;
		try {
			created = createPreviewStream(createRecognizer(modelDir), {
				sampleRate: SAMPLE_RATE,
				segmentCapMs: SEGMENT_CAP_MS,
				tailSilenceMs: TAIL_SILENCE_MS,
				now: () => performance.now(),
				onEvent: (event) => send(toResponse(event)),
			});
		} catch (error) {
			return fail(error);
		}
		stream = created;
		send({ type: "ready" });
	}

	function handle(request: WorkerRequest): void {
		switch (request.type) {
			case "init":
				init(request.modelDir);
				break;
			case "feed":
				stream?.feed(floatToPcm16(request.samples));
				break;
			case "flush":
				// Every flush is answered, including the one whose segment had nothing to drain (a pause right
				// after a boundary, or a stop the cap already committed): a pending flush must never wait out
				// the client's timeout, and `preview-stream` drops the no-op boundary itself.
				stream?.flush(request.reason);
				send({ type: "flushed", requestId: request.requestId });
				break;
			case "dispose":
				// Drop the segmenter, which is also the last reference to the recogniser: the native model goes
				// with it. `port.close()` would be the polite way to end the thread, but Bun keeps a worker alive
				// after its port is closed, so the exit is explicit and nothing may follow it.
				stream = null;
				process.exit(0);
		}
	}

	port.on("message", (request: WorkerRequest) => {
		try {
			handle(request);
		} catch (error) {
			// A throwing decode leaves the online stream's state untrustworthy, and `preview-stream`
			// deliberately propagates rather than masking it: map it onto the protocol's one failure channel.
			fail(error);
		}
	});
}

/**
 * Build the streaming recogniser for `modelDir`.
 *
 * File names and endpointing rules come from the catalogue entry, so the preview model keeps one
 * definition of its layout and its 1.2 s pause (`rule2MinTrailingSilence`), with `rule3MinUtteranceLength`
 * set out of reach at 600 — exactly one mechanism may end a segment, and the 60 s cap above is the other.
 * The rest of the decode configuration is this worker's: the addon's feature format, greedy search, and
 * two threads because the preview is a latency feature, not a throughput one.
 */
function createRecognizer(modelDir: string): OnlineRecognizerLike {
	const require = createRequire(import.meta.url);
	const sherpa = require("sherpa-onnx-node");
	const model = previewModel();
	const { files, endpointing } = model.sherpaModel;
	// Fail closed: without the rules the recogniser would still load, and pause detection would be silently
	// off — every segment then ends at the 60 s cap only, which no test downstream would notice.
	if (!endpointing) throw new Error(`preview model ${model.id} has no endpointing rules in the catalogue`);

	const paths = {
		encoder: join(modelDir, files.encoder),
		decoder: join(modelDir, files.decoder),
		tokens: join(modelDir, files.tokens),
	};
	// sherpa answers an unreadable path with "Please check your config!", which names nothing, and a model
	// that was never downloaded is the ordinary first-run failure: name the file for the debug channel.
	for (const file of Object.values(paths)) {
		if (!existsSync(file)) throw new Error(`missing preview model file: ${file}`);
	}

	return new sherpa.OnlineRecognizer({
		featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
		modelConfig: {
			paraformer: { encoder: paths.encoder, decoder: paths.decoder },
			tokens: paths.tokens,
			numThreads: 2,
			provider: "cpu",
			debug: 0,
		},
		decodingMethod: "greedy_search",
		...endpointing,
	});
}

/** `preview-stream`'s event kinds are the protocol's message types, renamed. */
function toResponse(event: PreviewStreamEvent): WorkerResponse {
	if (event.kind === "partial") {
		return { type: "partial", segmentId: event.segmentId, revision: event.revision, text: event.text };
	}
	return { type: "commit", segmentId: event.segmentId, text: event.text };
}

/**
 * Re-encode the client's float samples as the 16-bit LE PCM `preview-stream` accepts — the capture child's
 * wire format. The protocol carries float samples because that is what survives `postMessage` without a
 * byte-order assumption; the segmenter speaks the wire format, so this conversion belongs here. Clamping
 * keeps the scale inside the sample type, which is what makes `pcmToFloat32`'s fixed divisor safe.
 */
function floatToPcm16(samples: Float32Array): Buffer {
	const pcm = Buffer.alloc(samples.length * 2);
	for (let index = 0; index < samples.length; index++) {
		const clamped = Math.max(-1, Math.min(1, samples[index]));
		pcm.writeInt16LE(Math.round(clamped * 32767), index * 2);
	}
	return pcm;
}

// Only a worker thread runs the protocol: importing this module for its message types must not attach a
// listener, and nothing here may touch the native addon before `init`.
if (parentPort !== null) startPreviewWorker(parentPort);
