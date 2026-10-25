/**
 * One preview session: a recording's id, its transcript, its panel, and its terminal path.
 *
 * Spec: docs/superpowers/specs/2026-10-22-local-streaming-preview-design.md §4.3 (event rules),
 * §5.1 (abort writes nothing), §5.2 (panel lifecycle).
 *
 * Three of §4.3's rules are one fact about a recording each, and every caller that tried to hold one
 * of them separately would have to re-derive it from the event stream:
 *
 * - **Id filtering.** `recordingId` is taken from the channel's claim and never minted here; an event
 *   carrying any other id is dropped before it can reach the composer. Together with the terminal gate
 *   below, that is what keeps a retired recording's late commit out of the next recording's panel: the
 *   entrypoint can order the teardown, but it cannot make the channel stay silent.
 * - **The terminal gate.** `finish()` drains the last segment *first* and closes the gate after the
 *   drain, because the drain is precisely when the last commit arrives (§5.3: one flush per segment,
 *   including stop). Closing the gate earlier would discard the words spoken last — the same loss the
 *   segment drain exists to prevent. Once the gate is closed, every later event, including one with
 *   this recording's own id, is dropped.
 * - **`degraded` coalescing.** A recording is degraded or it is not: two failures are one fact. The
 *   first reason is recorded — it is the field the entrypoint folds into its single outcome notice
 *   (§5.5) — and the host is told once, so a worker that fails twice cannot produce two notices.
 *
 * The session is also the **only** owner of the panel's unmount. The panel is mounted on the first
 * event that can carry text (a degradation carries none, and an empty widget above the editor would
 * shift the layout for a recording that may never show a word) and unmounted exactly once, whichever
 * of `finish()` or `abort()` ends the recording. The entrypoint must not unmount it again, which is why
 * a second `finish()` and an `abort()` after the terminal are no-ops.
 *
 * Everything the host is asked to do is guarded, and `finish()` swallows a rejected flush: a TUI that
 * throws while mounting a widget, or a channel that breaks its own "never rejects" contract, must not
 * become a failure of the recording. The preview is never on the dictation's critical path.
 *
 * The composer stays readable after the terminal on purpose: `text` is the preview the entrypoint may
 * still need as the `unconfirmed` fallback (§5.4) once the recording has ended.
 */

import type { DegradeReason, PreviewChannel, PreviewEvent } from "./preview-worker-client";
import { createComposer } from "./transcript-composer";

export interface PreviewSessionHost {
	/** Show the panel. `getText` is re-read on every render, so the panel is never given a snapshot. */
	mountPanel(getText: () => string): void;
	/** Hide the panel. Called by the session, exactly once per recording. */
	unmountPanel(): void;
	/** The recording's one degradation, reported once, for the entrypoint to fold into its notice. */
	onDegraded(reason: DegradeReason, detail?: string): void;
}

export interface PreviewSession {
	/** Taken from the channel's claim; never minted here. */
	readonly recordingId: string;
	/** The transcript as it stands now: committed segments, then the live tail. */
	readonly text: string;
	/** The first degradation this recording suffered, or `null` while it is healthy. */
	readonly degraded: DegradeReason | null;
	/** Offer captured audio. Dropped once the terminal path has begun. */
	feed(chunk: Buffer): void;
	/** Apply one channel event. Foreign ids and post-terminal events are dropped. */
	handleEvent(event: PreviewEvent): void;
	/** Best-effort bounded flush, unmount, then `release()`. Never rejects. */
	finish(): Promise<void>;
	/** Cancel: unmount, then `destroy()` when no audio was fed, else `release()`. */
	abort(): void;
}

/** Run a host or channel side effect; the preview must never fail the recording it belongs to. */
function quietly(run: () => void): void {
	try {
		run();
	} catch {
		// Deliberately silent: the preview has no debug channel of its own here, and a throwing host is
		// its own bug — the recording keeps going either way.
	}
}

export function createPreviewSession(channel: PreviewChannel, host: PreviewSessionHost): PreviewSession {
	const recordingId = channel.recordingId;
	const composer = createComposer();

	/** The gate is closed: no more events, no more audio, and the panel is gone. */
	let closed = false;
	/** `finish()` was entered. Its drain still owns the terminal path, so `abort()` must not race it. */
	let finishing: Promise<void> | null = null;
	let mounted = false;
	/** Audio reached the channel, so an abort leaves a segment for the worker to drain. */
	let fedAudio = false;
	let degraded: DegradeReason | null = null;
	/** The one degradation has already been reported; later ones are only kept out, not repeated. */
	let degradedReported = false;

	function mount(): void {
		if (mounted) return;
		// Marked before the call so a throwing host does not make every event retry the mount.
		mounted = true;
		quietly(() => host.mountPanel(() => composer.text));
	}

	function unmount(): void {
		if (!mounted) return;
		mounted = false;
		quietly(() => host.unmountPanel());
	}

	/** Close the gate and take the panel away. Idempotent, because two terminal paths may race. */
	function close(): void {
		if (closed) return;
		// The gate is closed before the unmount, so an event delivered from inside the unmount cannot
		// remount the panel it is taking down.
		closed = true;
		unmount();
	}

	function degrade(reason: DegradeReason, detail: string | undefined): void {
		if (degraded === null) degraded = reason;
		if (degradedReported) return;
		degradedReported = true;
		quietly(() => host.onDegraded(reason, detail));
	}

	return {
		recordingId,

		get text(): string {
			return composer.text;
		},

		get degraded(): DegradeReason | null {
			return degraded;
		},

		feed(chunk: Buffer): void {
			// Once the drain has begun the recording's audio is closed: a late chunk would open a segment
			// after the stop flush and be dropped by `release()` anyway, and the final pass keeps every
			// sample regardless (§5.3: the cap segments the preview only).
			if (closed || finishing !== null) return;
			// The channel's own rule: shorter than one sample never opens a segment or spawns a worker,
			// so it is not audio and must not turn a zero-audio abort into a release.
			if (chunk.length >= 2) fedAudio = true;
			channel.feed(chunk);
		},

		handleEvent(event: PreviewEvent): void {
			if (closed || event.recordingId !== recordingId) return;
			switch (event.kind) {
				case "partial":
					composer.applyPartial(event.segmentId ?? 0, event.revision ?? 0, event.text ?? "");
					mount();
					return;
				case "commit":
					// An empty commit still closes a segment, and its id can be 0 even on a warm worker
					// (§4.3: the failed flush commits what the segment was showing). Neither may throw or
					// rewrite visible text, so nothing here inspects the text or the id.
					composer.applyCommit(event.segmentId ?? 0, event.text ?? "");
					mount();
					return;
				case "degraded":
					// The spec's type makes the reason mandatory; the default keeps a malformed event from
					// becoming invisible rather than pretending no degradation happened.
					degrade(event.reason ?? "preview-worker-failed", event.detail);
					return;
			}
		},

		finish(): Promise<void> {
			if (finishing !== null) return finishing;
			if (closed) return Promise.resolve();
			finishing = (async () => {
				try {
					// One flush per recording, and the channel bounds it with its own timeout: a failed or
					// timed-out drain becomes `degraded` plus an empty commit there, never a rejection here.
					await channel.flush("stop");
				} catch {
					// A rejected flush means the channel broke its contract. There is nothing to report: the
					// channel already owns the degradation, and the recording must not inherit the failure.
				}
				close();
				quietly(() => channel.release());
			})();
			return finishing;
		},

		abort(): void {
			// A stop already in flight owns the teardown; unmounting here would race its drain and release
			// a claim it is still flushing.
			if (closed || finishing !== null) return;
			close();
			if (fedAudio) {
				// Audio reached the worker, so `release()` drains the abandoned segment with its own
				// maintenance flush and keeps the worker warm for the next recording (§5.5).
				quietly(() => channel.release());
				return;
			}
			// Nothing reached the worker: there is no segment to drain, and a recording that never spoke
			// leaves no reason to keep a warm worker alive.
			quietly(() => {
				void channel.destroy().catch(() => {});
			});
		},
	};
}
