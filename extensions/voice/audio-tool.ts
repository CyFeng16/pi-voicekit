/**
 * Capture-tool preference.
 *
 * SoX' `rec` is the best default for local capture, but it is known to stall on
 * network PulseAudio servers: over an SSH audio tunnel (`PULSE_SERVER` pointing at
 * a forwarded TCP port, e.g. `tcp:127.0.0.1:4713`) the same `rec` invocation
 * returned zero bytes in 40% of runs on this stack, while ffmpeg was reliable in
 * every run. So when a remote Pulse server is configured, probe ffmpeg first and
 * keep SoX as the fallback; local capture keeps SoX first.
 */

export type AudioToolName = "ffmpeg" | "sox" | "arecord";

export function audioToolOrder(env: { PULSE_SERVER?: string | undefined } = process.env): AudioToolName[] {
	return env.PULSE_SERVER ? ["ffmpeg", "sox", "arecord"] : ["sox", "ffmpeg", "arecord"];
}
