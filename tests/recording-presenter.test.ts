import { expect, test } from "bun:test";
import { createRecordingPresenter, type WidgetFactory } from "../extensions/voice/recording-presenter";
import { makeWidgetRegistry, type DisposableWidget } from "../extensions/voice/ui-widget-base";

function fixture(hasUI = true, throwOnClear = false) {
	let now = 0;
	const registry = makeWidgetRegistry();
	const slots = new Map<string, WidgetFactory>();
	const writes: { key: string; placement?: string; empty: boolean }[] = [];
	const timers = new Set<{ fn(): void; ms: number; next: number }>();
	let cancellations = 0;
	const states: string[] = [];
	const diagnostics: string[] = [];
	const presenter = createRecordingPresenter({
		registry: () => registry,
		hasUI: () => hasUI,
		now: () => now,
		getHoldThresholdMs: () => 1200,
		getRecordingStart: () => 0,
		setWidget(key, factory, opts) {
			if (!factory && throwOnClear) throw new Error("host clear failed");
			writes.push({ key, placement: opts?.placement, empty: !factory });
			if (factory) slots.set(key, factory);
			else slots.delete(key);
		},
		schedule(fn, ms) {
			const timer = { fn, ms, next: now + ms };
			timers.add(timer);
			return () => {
				if (timers.delete(timer)) cancellations++;
			};
		},
		setState: (state) => states.push(state),
		notify() {},
		playSound() {},
		debug(message) {
			diagnostics.push(message);
		},
	});
	return {
		presenter,
		registry,
		slots,
		writes,
		states,
		diagnostics,
		get cancellations() {
			return cancellations;
		},
		advance(ms: number) {
			const end = now + ms;
			while (true) {
				const next = [...timers].sort((a, b) => a.next - b.next)[0];
				if (!next || next.next > end) break;
				now = next.next;
				next.next += next.ms;
				next.fn();
			}
			now = end;
		},
		render(key = "voice-recording") {
			return slots
				.get(key)?.({ requestRender() {} }, { fg: (_color, text) => text })
				.render(60)
				.join("\n");
		},
	};
}

test("warmup renders immediately and at 90 ms; recording renders immediately and at 150 ms", () => {
	const f = fixture();
	f.presenter.mountWarmupIndicator();
	expect(f.writes).toHaveLength(1);
	expect(f.render()).toContain("hold to record");
	f.advance(89);
	expect(f.writes).toHaveLength(1);
	f.advance(1);
	expect(f.writes).toHaveLength(2);
	f.presenter.mountRecordingIndicator();
	expect(f.writes).toHaveLength(3);
	expect(f.render()).toContain("Voice Input");
	f.advance(149);
	expect(f.writes).toHaveLength(3);
	f.advance(1);
	expect(f.writes).toHaveLength(4);
	f.presenter.dispose();
});

test("same-key handover disposes the previous owner once without a visible clear", () => {
	const f = fixture();
	const owners: DisposableWidget[] = [];
	const register = f.registry.register.bind(f.registry);
	f.registry.register = (owner) => {
		owners.push(owner);
		register(owner);
	};
	f.presenter.mountWarmupIndicator();
	f.presenter.mountRecordingIndicator();
	expect(owners.map((owner) => owner.key)).toEqual(["voice-recording", "voice-recording"]);
	expect(f.cancellations).toBe(1);
	expect(f.writes.some((write) => write.empty)).toBe(false);
	f.registry.unregister("voice-recording", owners[0]!);
	owners[0]!.dispose();
	expect(f.registry.size()).toBe(1);
	expect(f.slots.has("voice-recording")).toBe(true);
	f.presenter.unmountRecordingIndicator();
	expect(f.registry.size()).toBe(0);
	expect(f.slots.size).toBe(0);
	expect(f.cancellations).toBe(2);
	const count = f.writes.length;
	f.presenter.unmountRecordingIndicator();
	f.advance(1000);
	expect(f.writes).toHaveLength(count);
});

test("the preview panel mounts above the editor, reads live text and unmounts once", () => {
	const f = fixture();
	let text = "first";
	f.presenter.mountPanel(() => text);
	expect(f.writes[0]?.placement).toBe("aboveEditor");
	expect(f.render("voice-preview")).toBe("first");
	text = "second";
	expect(f.render("voice-preview")).toBe("second");
	f.presenter.unmountPanel();
	f.presenter.unmountPanel();
	expect(f.writes.filter((write) => write.empty)).toHaveLength(1);
	expect(f.registry.size()).toBe(0);
});

test("state transitions never mount an indicator or an absent preview", () => {
	const f = fixture();
	for (const state of ["warmup", "recording", "finalizing", "idle"] as const) f.presenter.setState(state);
	expect(f.states).toEqual(["warmup", "recording", "finalizing", "idle"]);
	expect(f.slots.size).toBe(0);
	expect(f.writes).toHaveLength(0);
	f.presenter.setState("recording");
	expect(f.states.at(-1)).toBe("recording");
	expect(f.slots.size).toBe(0);
	f.presenter.mountRecordingIndicator();
	expect(f.slots.has("voice-recording")).toBe(true);
});

test("audio level and progress change the rendered indicator", () => {
	const f = fixture();
	f.presenter.mountWarmupIndicator();
	f.presenter.setProgress(60, 1200);
	f.presenter.renderWarmupFrame();
	const early = f.render();
	f.presenter.setProgress(600, 1200);
	f.presenter.renderWarmupFrame();
	expect(f.render()).not.toBe(early);
	f.advance(600);
	f.presenter.mountRecordingIndicator();
	f.presenter.setAudioLevel(0.1);
	const quiet = f.render();
	f.presenter.setAudioLevel(0.8);
	expect(f.render()).not.toBe(quiet);
	f.presenter.dispose();
});

test("timer-only cleanup preserves the slot; disposal drains registry and timers", () => {
	const f = fixture();
	f.presenter.mountWarmupIndicator();
	f.presenter.stopWarmupAnimation();
	f.advance(1000);
	expect(f.writes).toHaveLength(1);
	expect(f.slots.size).toBe(1);
	f.registry.disposeAll();
	expect(f.slots.size).toBe(0);
	expect(f.registry.size()).toBe(0);
	f.presenter.dispose();
});

test("a throwing host clear cannot strand the timer or registry owner", () => {
	const f = fixture(true, true);
	f.presenter.mountRecordingIndicator();
	expect(() => f.presenter.hideIndicator()).not.toThrow();
	expect(f.registry.size()).toBe(0);
	expect(f.cancellations).toBe(1);
	expect(f.diagnostics).toEqual(["hideWidget threw"]);
	f.advance(1000);
	expect(f.writes).toHaveLength(1);
});

test("headless mounting makes no writes and schedules nothing", () => {
	const f = fixture(false);
	f.presenter.mountWarmupIndicator();
	f.presenter.mountRecordingIndicator();
	f.presenter.mountPanel(() => "text");
	f.advance(1000);
	expect(f.writes).toHaveLength(0);
	expect(f.registry.size()).toBe(0);
});
