/**
 * Hold-to-talk release-detection policy — extracted from voice.ts so the
 * state-machine decisions are unit-testable.
 *
 * Background (upstream #13): terminals without key-release events
 * (e.g. Ghostty on macOS in non-kitty modes) signal "key released" purely by
 * a GAP in key-repeat events. Every repeat event must therefore re-arm the
 * release-detect timer; otherwise recording state locks up forever — the
 * timer is cleared at recording start and nothing ever re-arms it.
 *
 * Kitty-protocol terminals DO emit real key-release events, so gap-based
 * detection is unnecessary there — arming it would just make an occasional
 * repeat pause look like a release.
 */

export type HoldState = "idle" | "warmup" | "recording" | "finalizing";

export interface SpaceHoldContext {
	voiceState: HoldState;
	kittyReleaseDetected: boolean;
}

/**
 * Whether a SPACE key-repeat arriving during recording/finalizing must re-arm
 * the gap-based release-detect timer before being consumed.
 *
 * - Kitty terminals: true key-release events exist → never arm (a repeat
 *   pause must not be mistaken for a release).
 * - Non-kitty terminals: the only "release" signal is a gap in repeats, so
 *   every repeat re-arms the 250ms timer — the #13 fix.
 *
 * The hold-counter path (spaceDownTime && !holdConfirmed) re-arms in its own
 * branch at the call site and is intentionally NOT covered here.
 */
export function shouldArmReleaseDetectOnRepeat(ctx: SpaceHoldContext): boolean {
	if (ctx.kittyReleaseDetected) return false;
	// 仅录音已就绪（recording/finalizing）时 re-arm。warmup 或仅有
	// spaceConsumed 的启动间隙不 arm——此时 arm 的 timer 到期会命中
	// onSpaceReleaseDetected 的 warmup 取消分支而产生 false stop
	// （上游 PATH B 注释亦明确启动期不可 re-arm，恢复由 recording
	// 就绪时的统一 arm + 此处的 repeat 维持承担）。
	return ctx.voiceState === "recording" || ctx.voiceState === "finalizing";
}

export type RecordingStartTimerAction = "arm" | "clear";

/**
 * What to do with the release-detect timer once recording is actually ready.
 *
 * Called ONLY after the recording state-machine has fully transitioned to
 * "recording" (successful start). Arm it before that and a slow async startup
 * would hit onSpaceReleaseDetected's warmup branch — a false "early release".
 *
 * - isHold (spaceDownTime set — hold-to-talk session): non-kitty terminals arm
 *   a fresh (250ms) timer — key-up is detected purely by a gap in repeats,
 *   and repeats keep re-arming it from here on. This also covers releases that
 *   happen during the startup window. Kitty terminals stay clear (real
 *   key-release event governs).
 * - toggle/dictation sessions (no spaceDownTime): NEVER arm — there is no
 *   repeat stream keeping the timer alive, so arming would auto-stop them
 *   250ms after start.
 */
export function decideRecordingStartTimer(ctx: {
	kittyReleaseDetected: boolean;
	isHold: boolean;
}): RecordingStartTimerAction {
	return !ctx.kittyReleaseDetected && ctx.isHold ? "arm" : "clear";
}
