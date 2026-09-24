/**
 * Gap-based release-deadline timer for hold-to-talk (non-kitty terminals).
 *
 * Extracted from voice.ts so the re-arm lifetime — the #13 fix core — is
 * testable against a fake clock. voice.ts maps resetReleaseDetect /
 * clearReleaseTimer / onSpaceReleaseDetected directly onto this class.
 *
 * Semantics: a single-shot deadline that resets on every arm(). It fires
 * exactly once when the configured interval elapses without a fresh arm() —
 * i.e. a key-repeat gap means "the user released the key".
 */
export interface TimerPort {
	/** Arm a one-shot that fires `fn` after `ms`; returns a cancel handle. */
	once(fn: () => void, ms: number): { cancel(): void };
}

export interface GapTimerOptions {
	/** Deadline in ms — reset on every arm(). */
	ms: number;
	/** Called exactly once when the deadline elapses without re-arm. */
	onFire: () => void;
}

export class GapTimer {
	private cancelFn: (() => void) | null = null;
	private readonly port: TimerPort;
	private readonly ms: number;
	private readonly onFire: () => void;

	constructor(port: TimerPort, opts: GapTimerOptions) {
		this.port = port;
		this.ms = opts.ms;
		this.onFire = opts.onFire;
	}

	/** Arm (or re-arm) the release-deadline. */
	arm(): void {
		this.cancel();
		const handle = this.port.once(() => {
			this.cancelFn = null;
			this.onFire();
		}, this.ms);
		this.cancelFn = handle.cancel;
	}

	/** Cancel any pending deadline. Safe to call when not armed. */
	cancel(): void {
		this.cancelFn?.();
		this.cancelFn = null;
	}

	get active(): boolean {
		return this.cancelFn != null;
	}
}
