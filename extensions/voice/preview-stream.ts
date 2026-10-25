/**
 * The preview's segmenting rules: one online stream per segment, one commit per segment.
 *
 * Spec: docs/superpowers/specs/2026-10-22-local-streaming-preview-design.md §5.3.
 *
 * A segment ends at an endpoint (the pause the online recogniser reports) or at the hard cap, and
 * every boundary — the last one at stop included — drains its tail. A chunk-based streaming
 * recogniser decodes only once a full feature frame has accumulated, so committing a segment without
 * the drain silently drops the words spoken just before its boundary while every test still passes.
 * The drain is `tailSilenceMs` of silence, `inputFinished()`, then decode until `isReady()` is false.
 *
 * The cap ends a segment, not the stream: a fresh online stream opens for the same recording, so only
 * the encoder state is dropped and audio after the boundary keeps flowing to the successor. Time
 * arrives through `now()` — this module owns no timers — and the cap clock restarts at every segment,
 * with the chunk that crosses the cap belonging to the successor.
 *
 * No I/O and no worker: the recogniser is injected, which is what makes the segmenting and the drain
 * order testable without a model. Failure mapping is the caller's: a decode that throws propagates.
 */

/** One online decoding stream, as `sherpa-onnx-node`'s `OnlineStream` exposes it. */
export interface PreviewStreamLike {
	acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
	inputFinished(): void;
}

/** The slice of `sherpa-onnx-node`'s `OnlineRecognizer` this module drives. */
export interface OnlineRecognizerLike {
	createStream(): PreviewStreamLike;
	isReady(stream: PreviewStreamLike): boolean;
	decode(stream: PreviewStreamLike): void;
	isEndpoint(stream: PreviewStreamLike): boolean;
	getResult(stream: PreviewStreamLike): { text: string };
}

/** The two things the composer consumes: a replaceable tail per segment, and immutable finished text. */
export type PreviewStreamEvent =
	| { kind: "partial"; segmentId: number; revision: number; text: string }
	| { kind: "commit"; segmentId: number; text: string };

export interface PreviewStreamOptions {
	/** Sample rate of the PCM the capture child delivers; every stream accepts audio at this rate. */
	sampleRate: number;
	/** Hard cap per segment. Bounds the encoder state, never the recording. */
	segmentCapMs: number;
	/** Silence fed before `inputFinished()` so the last words of a segment are decoded, not dropped. */
	tailSilenceMs: number;
	/** Owner-supplied clock, so the cap can be tested without waiting a minute. */
	now: () => number;
	onEvent: (event: PreviewStreamEvent) => void;
}

/**
 * Segment a preview recording.
 *
 * `feed()` accepts 16 kHz mono PCM16LE — the capture child's wire format — and is the only place a
 * segment can open. `flush()` ends the open segment if it holds audio: a flush of a segment that was
 * never fed (a pause right after a boundary, or the stop after the cap already committed) is a no-op
 * rather than an empty duplicate commit, which is what keeps one flush per segment.
 *
 * All three flush reasons share the drain path: the reason is the caller's, and says why the boundary
 * was asked for, not something this module acts on differently.
 */
export function createPreviewStream(
	recognizer: OnlineRecognizerLike,
	options: PreviewStreamOptions
): {
	feed(chunk: Buffer): void;
	flush(reason: "pause" | "cap" | "stop"): void;
} {
	const tailSamples = Math.round((options.sampleRate * options.tailSilenceMs) / 1000);
	// Every boundary feeds the same silence; a long recording should not allocate 25 KB per segment.
	const tailSilence = new Float32Array(tailSamples);

	/** The segment currently accepting audio; `null` between a commit and the next chunk. */
	let stream: PreviewStreamLike | null = null;
	/** When the open segment began, from `options.now()`. Unused while `stream` is `null`. */
	let segmentStartedAt = 0;
	let segmentId = 0;
	/** Monotonic for the whole recording: a revision can never make an older tail look newer. */
	let revision = 0;
	/** The last text emitted as a partial for the open segment. */
	let lastText = "";

	function decodedText(of: PreviewStreamLike): string {
		return recognizer.getResult(of).text.trim();
	}

	/** Drain the open segment's tail, retire it, and emit its one commit. */
	function endSegment(): void {
		const ending = stream;
		// No open segment: nothing was fed yet, or this boundary already committed. A flush must not
		// manufacture an empty duplicate commit — that is what keeps it at one flush per segment.
		if (ending === null) return;

		ending.acceptWaveform({ sampleRate: options.sampleRate, samples: tailSilence });
		ending.inputFinished();
		while (recognizer.isReady(ending)) recognizer.decode(ending);
		const text = decodedText(ending);

		// Retire before emitting: a throwing consumer must not be able to commit this segment twice.
		const endingId = segmentId;
		stream = null;
		lastText = "";
		segmentId += 1;
		options.onEvent({ kind: "commit", segmentId: endingId, text });
	}

	function feed(chunk: Buffer): void {
		const sampleCount = Math.floor(chunk.length / 2);
		if (sampleCount === 0) return; // not even one sample: no audio, no boundary

		const at = options.now();
		if (stream !== null && at - segmentStartedAt >= options.segmentCapMs) {
			// The cap ends this segment; the chunk that crossed it belongs to the successor.
			endSegment();
		}
		if (stream === null) {
			stream = recognizer.createStream();
			// The successor's clock starts with its stream, i.e. after the drain that closed its predecessor,
			// so the drain's own duration is never charged to the new segment.
			segmentStartedAt = options.now();
		}

		const current = stream;
		current.acceptWaveform({ sampleRate: options.sampleRate, samples: pcmToFloat32(chunk, sampleCount) });
		while (recognizer.isReady(current)) recognizer.decode(current);

		const text = decodedText(current);
		if (text !== lastText) {
			lastText = text;
			revision += 1;
			options.onEvent({ kind: "partial", segmentId, revision, text });
		}

		if (recognizer.isEndpoint(current)) endSegment();
	}

	function flush(_reason: "pause" | "cap" | "stop"): void {
		endSegment();
	}

	return { feed, flush };
}

/**
 * Convert the capture child's 16-bit signed LE PCM to the float samples sherpa accepts.
 *
 * Pooled Buffers can start at an odd byte offset, where an `Int16Array` view throws; the per-sample
 * read is that fallback, not the fast path. A trailing odd byte is not a sample and is dropped.
 */
function pcmToFloat32(pcm: Buffer, sampleCount: number): Float32Array {
	const samples = new Float32Array(sampleCount);
	if ((pcm.byteOffset & 1) === 0) {
		const int16 = new Int16Array(pcm.buffer, pcm.byteOffset, sampleCount);
		for (let i = 0; i < sampleCount; i++) samples[i] = int16[i] / 32768;
		return samples;
	}
	for (let i = 0; i < sampleCount; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
	return samples;
}
