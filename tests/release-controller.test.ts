import { describe, expect, test } from "bun:test";
import { GapTimer, type TimerPort } from "../extensions/voice/release-controller";

/**
 * Fake clock. `once(fn, ms)` registers; `advance(ms)` moves time forward and
 * fires every callback whose deadline passed — in scheduling order.
 */
class FakeTimers implements TimerPort {
	private time = 0;
	private nextId = 0;
	private pending = new Map<number, { at: number; fn: () => void }>();

	once(fn: () => void, ms: number): { cancel(): void } {
		const id = ++this.nextId;
		this.pending.set(id, { at: this.time + ms, fn });
		return {
			cancel: () => {
				this.pending.delete(id);
			},
		};
	}

	advance(ms: number): void {
		this.time += ms;
		for (const [id, entry] of [...this.pending]) {
			if (entry.at <= this.time) {
				this.pending.delete(id);
				entry.fn();
			}
		}
	}

	get count(): number {
		return this.pending.size;
	}
}

describe("GapTimer — gap-based release detection (#13 core)", () => {
	test("fires exactly once when the full interval elapses without re-arm", () => {
		const timers = new FakeTimers();
		let fires = 0;
		const t = new GapTimer(timers, { ms: 250, onFire: () => fires++ });

		t.arm();
		timers.advance(249);
		expect(fires).toBe(0);
		expect(t.active).toBe(true);

		timers.advance(1);
		expect(fires).toBe(1);
		expect(t.active).toBe(false);
	});

	test("repeat events re-arm and keep the deadline alive; a gap then fires (the #13 semantics)", () => {
		const timers = new FakeTimers();
		let fires = 0;
		const t = new GapTimer(timers, { ms: 250, onFire: () => fires++ });

		t.arm();
		// key-repeat pair at ~200ms intervals — every repeat pushes the deadline
		for (let i = 0; i < 10; i++) {
			timers.advance(200);
			t.arm();
			expect(fires).toBe(0); // never fires while holding
		}
		// user released → no more repeats → deadline elapses → stop signal
		timers.advance(250);
		expect(fires).toBe(1);
	});

	test("cancel prevents firing and reports inactive", () => {
		const timers = new FakeTimers();
		let fires = 0;
		const t = new GapTimer(timers, { ms: 250, onFire: () => fires++ });

		t.arm();
		t.cancel();
		expect(t.active).toBe(false);
		timers.advance(1000);
		expect(fires).toBe(0);
	});

	test("arm always resets — an early re-arm cancels the previous deadline", () => {
		const timers = new FakeTimers();
		let fires = 0;
		const t = new GapTimer(timers, { ms: 250, onFire: () => fires++ });

		t.arm();
		timers.advance(100);
		t.arm(); // reset
		timers.advance(100); // still 150ms away from the new deadline
		expect(fires).toBe(0);
		timers.advance(150);
		expect(fires).toBe(1);
	});

	test("arm storm fires only once (no fire-and-forget duplicates)", () => {
		const timers = new FakeTimers();
		let fires = 0;
		const t = new GapTimer(timers, { ms: 250, onFire: () => fires++ });

		for (let i = 0; i < 100; i++) t.arm();
		timers.advance(10_000);
		expect(fires).toBe(1);
		expect(timers.count).toBe(0);
	});

	test("never armed → nothing fires", () => {
		const timers = new FakeTimers();
		let fires = 0;
		new GapTimer(timers, { ms: 250, onFire: () => fires++ });
		timers.advance(10_000);
		expect(fires).toBe(0);
	});
});
