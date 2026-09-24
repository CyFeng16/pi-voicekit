import { describe, expect, test } from "bun:test";
import { audioToolOrder } from "../extensions/voice/audio-tool";

describe("audioToolOrder", () => {
	test("prefers SoX for local capture (no remote Pulse server)", () => {
		expect(audioToolOrder({})).toEqual(["sox", "ffmpeg", "arecord"]);
		expect(audioToolOrder({ PULSE_SERVER: undefined })).toEqual(["sox", "ffmpeg", "arecord"]);
	});

	test("prefers ffmpeg when PULSE_SERVER points at a remote Pulse server", () => {
		// e.g. an SSH audio tunnel: `pi-voice-remote` exports tcp:127.0.0.1:4713
		expect(audioToolOrder({ PULSE_SERVER: "tcp:127.0.0.1:4713" })).toEqual(["ffmpeg", "sox", "arecord"]);
		expect(audioToolOrder({ PULSE_SERVER: "tcp:192.168.1.9:4713" })).toEqual(["ffmpeg", "sox", "arecord"]);
	});

	test("treats an empty PULSE_SERVER as unset", () => {
		expect(audioToolOrder({ PULSE_SERVER: "" })).toEqual(["sox", "ffmpeg", "arecord"]);
	});

	test("keeps arecord last in both orders", () => {
		for (const env of [{}, { PULSE_SERVER: "tcp:127.0.0.1:4713" }]) {
			expect(audioToolOrder(env).at(-1)).toBe("arecord");
		}
	});
});
