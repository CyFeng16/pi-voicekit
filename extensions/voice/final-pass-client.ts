import { Worker } from "node:worker_threads";
import type { FinalRequest, FinalResponse } from "./final-pass-worker";
import { resolveWorkerEntry } from "./worker-entry";

export interface FinalWorkerLike {
	postMessage(message: FinalRequest): void;
	on(event: string, listener: (...args: any[]) => void): unknown;
	terminate(): unknown;
	ref?(): unknown;
	unref?(): unknown;
}

type Result = { text: string; hadSpeech: boolean };
type SegmentObserver = (text: string, index: number) => void;
export interface FinalPassClient {
	readonly signal: AbortSignal;
	transcribe(
		pcm: Buffer,
		options?: { signal?: AbortSignal; onSegment?: SegmentObserver } | SegmentObserver
	): Promise<Result>;
	rebind(modelId: string, modelDir: string, language: string): Promise<void>;
	destroy(): Promise<void>;
}

interface Job {
	pcm: Uint8Array;
	onSegment?: SegmentObserver;
	cleanup(): void;
	resolve(result: Result): void;
	reject(error: Error): void;
}

/** A dedicated resident worker: final decoding never queues behind preview decoding. */
export function createFinalPassClient(
	opts: {
		spawnWorker?: (url: URL) => FinalWorkerLike;
		timeoutMs?: number;
	} = {}
): FinalPassClient {
	const spawn = opts.spawnWorker ?? ((url: URL) => new Worker(url));
	const timeoutMs = opts.timeoutMs ?? 120_000;
	let binding: Extract<FinalRequest, { type: "init" }> | null = null;
	let worker: FinalWorkerLike | null = null;
	let ready = false;
	let active: Job | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const queue: Job[] = [];
	let lifecycle = new AbortController();

	function retire(message: string): Promise<void> {
		const old = worker;
		worker = null;
		ready = false;
		clearTimeout(timer);
		const jobs = active ? [active, ...queue] : [...queue];
		active = null;
		queue.length = 0;
		for (const job of jobs) {
			job.cleanup();
			job.reject(new Error(message));
		}
		try {
			return Promise.resolve(old?.terminate()).then(
				() => {},
				() => {}
			);
		} catch {
			return Promise.resolve();
		}
	}

	// Job object identity scopes cancellation and deadlines; retiring its worker fences late messages.
	function cancelJob(job: Job, message: string): void {
		if (active === job) {
			const old = worker;
			worker = null;
			ready = false;
			active = null;
			clearTimeout(timer);
			try {
				void Promise.resolve(old?.terminate()).catch(() => {});
			} catch {}
		} else {
			const index = queue.indexOf(job);
			if (index < 0) return;
			queue.splice(index, 1);
		}
		job.cleanup();
		job.reject(new Error(message));
		pump();
	}

	function post(message: FinalRequest): void {
		try {
			worker?.postMessage(message);
		} catch (error) {
			void retire(describe(error));
		}
	}

	function sendAudio(): void {
		if (active) post({ type: "transcribe", pcm: active.pcm });
	}

	function handle(message: FinalResponse): void {
		if (message.type === "failed") {
			void retire(message.message);
		} else if (message.type === "ready" && !ready) {
			ready = true;
			sendAudio();
		} else if (message.type === "segment" && ready && active) {
			try {
				active.onSegment?.(message.text, message.index);
			} catch {
				/* Observers cannot fail transcription. */
			}
		} else if (message.type === "result" && ready && active) {
			const job = active;
			active = null;
			clearTimeout(timer);
			job.cleanup();
			job.resolve({ text: message.text, hadSpeech: message.hadSpeech });
			pump();
		}
	}

	function pump(): void {
		if (active) return;
		active = queue.shift() ?? null;
		if (!active) {
			worker?.unref?.();
			return;
		}
		// The host deadline includes cold construction and settles even while native decoding is stuck.
		const job = active;
		timer = setTimeout(() => {
			cancelJob(
				job,
				timeoutMs === 120_000 ? "Transcription timed out (120s)" : `Transcription timed out (${timeoutMs}ms)`
			);
		}, timeoutMs);
		try {
			if (!worker) {
				const created = spawn(resolveWorkerEntry("final-pass-worker", import.meta.url));
				worker = created;
				created.on("message", (message: FinalResponse) => {
					if (worker === created) handle(message);
				});
				created.on("error", (error: unknown) => {
					if (worker === created) void retire(describe(error));
				});
				created.on("exit", (code: unknown) => {
					if (worker === created) void retire(`Final worker exited with code ${String(code)}`);
				});
				post(binding!);
			} else {
				worker.ref?.();
				if (ready) sendAudio();
			}
		} catch (error) {
			void retire(describe(error));
		}
	}

	return {
		get signal() {
			return lifecycle.signal;
		},
		transcribe(pcm, options = {}) {
			if (!binding) return Promise.reject(new Error("Final worker has no model binding"));
			const { signal, onSegment } = typeof options === "function" ? { onSegment: options, signal: undefined } : options;
			if (signal?.aborted) return Promise.reject(new Error("Transcription cancelled"));
			return new Promise<Result>((resolve, reject) => {
				const abort = () => cancelJob(job, "Transcription cancelled");
				// Copy, not transfer: capture/preview consumers may still own the original pooled Buffer.
				const job: Job = {
					pcm: new Uint8Array(pcm),
					onSegment,
					resolve,
					reject,
					cleanup: () => signal?.removeEventListener("abort", abort),
				};
				queue.push(job);
				signal?.addEventListener("abort", abort, { once: true });
				pump();
			});
		},
		rebind(modelId, modelDir, language) {
			const baseLanguage = language.split("-")[0] || language;
			if (binding?.modelId === modelId && binding.modelDir === modelDir && binding.language === baseLanguage)
				return Promise.resolve();
			binding = { type: "init", modelId, modelDir, language: baseLanguage };
			// Lazy rebuild: a settings change must not incur a load until final audio actually needs it.
			return retire("Final worker rebound to a different model or language");
		},
		destroy: () => {
			const old = lifecycle;
			lifecycle = new AbortController();
			const retired = retire("Final worker destroyed");
			old.abort();
			return retired;
		},
	};
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Shared by local capture and extension lifecycle/settings invalidation. No thread until first audio. */
export const finalPassClient = createFinalPassClient();
