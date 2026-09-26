import { describe, expect, test } from "bun:test";
import { THINKING_MAX_CHARS, type AssistantLike } from "../extensions/voice/post-process";
import {
	createPolishQueue,
	joinSegments,
	POLISH_QUEUE_CONCURRENCY,
	type QueuePolishRequest,
} from "../extensions/voice/post-process-queue";

const assistant = (text: string): AssistantLike => ({
	stopReason: "stop",
	content: [{ type: "text", text }],
});

/** The raw segment a request carries, so a stub caller can answer per segment. */
const requestedRaw = (request: QueuePolishRequest): string =>
	/<TRANSCRIPT>\n([\s\S]*?)\n<\/TRANSCRIPT>/.exec(request.messages[0]!.content)?.[1] ?? "";

/** Let every queued microtask and the pool's next start run. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

describe("joinSegments", () => {
	test("joins Chinese without a space and English with one", () => {
		expect(joinSegments(["这是第一段", "这是第二段"])).toBe("这是第一段这是第二段");
		expect(joinSegments(["first part", "second part"])).toBe("first part second part");
		// A boundary behind CJK punctuation is still a Chinese boundary, and a mixed zh-en
		// boundary keeps the space that makes the term readable.
		expect(joinSegments(["第一段。", "第二段"])).toBe("第一段。第二段");
		expect(joinSegments(["用 retry", "重试一次"])).toBe("用 retry 重试一次");
	});

	test("drops empty parts instead of injecting a stray space", () => {
		expect(joinSegments([])).toBe("");
		expect(joinSegments(["only"])).toBe("only");
		expect(joinSegments(["first part", "", "second part"])).toBe("first part second part");
		expect(joinSegments(["第一段", "  ", "第二段"])).toBe("第一段第二段");
	});
});

describe("createPolishQueue", () => {
	test("keeps the output order even when segments finish out of order", async () => {
		const pending = new Map<string, (message: AssistantLike) => void>();
		const queue = createPolishQueue({
			timeoutMs: 500,
			call: (request) =>
				new Promise<AssistantLike>((resolve) => {
					pending.set(requestedRaw(request), resolve);
				}),
		});
		queue.push(1, "RAW-ONE");
		queue.push(0, "RAW-ZERO");
		// Both segments are already in flight before finish(): that is what lets polish
		// overlap recognition instead of waiting for every segment to arrive.
		expect([...pending.keys()].sort()).toEqual(["RAW-ONE", "RAW-ZERO"]);
		// Resolve in reverse arrival order.
		pending.get("RAW-ONE")?.(assistant("POLISHED-ONE"));
		pending.get("RAW-ZERO")?.(assistant("POLISHED-ZERO"));
		const result = await queue.finish();
		expect(result.text).toBe("POLISHED-ZERO POLISHED-ONE");
		expect(result.segments.map((segment) => segment.index)).toEqual([0, 1]);
		expect(result.segments.map((segment) => segment.status)).toEqual(["applied", "applied"]);
		expect(result.polished).toBe(2);
		expect(result.failed).toBe(0);
	});

	test("runs at most POLISH_QUEUE_CONCURRENCY calls at once", async () => {
		let live = 0;
		let peak = 0;
		const releases: (() => void)[] = [];
		const queue = createPolishQueue({
			timeoutMs: 1000,
			call: () =>
				new Promise<AssistantLike>((resolve) => {
					live += 1;
					peak = Math.max(peak, live);
					releases.push(() => {
						live -= 1;
						resolve(assistant("done"));
					});
				}),
		});
		for (let index = 0; index < 6; index += 1) queue.push(index, `RAW-${index}`);
		// The cap holds on arrival, not only once every segment is known.
		expect(peak).toBe(POLISH_QUEUE_CONCURRENCY);
		while (releases.length > 0) {
			releases.shift()?.();
			// A slot freed by one segment must not let two new ones start.
			await tick();
			expect(peak).toBeLessThanOrEqual(POLISH_QUEUE_CONCURRENCY);
		}
		const result = await queue.finish();
		expect(result.segments).toHaveLength(6);
		expect(result.polished).toBe(6);
		expect(peak).toBe(POLISH_QUEUE_CONCURRENCY);
	});

	test("isolates a failing segment", async () => {
		const queue = createPolishQueue({
			timeoutMs: 30,
			call: (request) => {
				const raw = requestedRaw(request);
				// Segment 1 hangs: its own timeout must not cost its neighbours their polish.
				if (raw === "segment one raw") return new Promise<AssistantLike>(() => {});
				return Promise.resolve(assistant(raw.replace("raw", "polished")));
			},
		});
		queue.push(0, "segment zero raw");
		queue.push(1, "segment one raw");
		queue.push(2, "segment two raw");
		const result = await queue.finish();
		expect(result.text).toBe("segment zero polished segment one raw segment two polished");
		expect(result.polished).toBe(2);
		expect(result.failed).toBe(1);
		expect(result.segments.map((segment) => segment.status)).toEqual(["applied", "fallback", "applied"]);
		expect(result.segments[1]!.text).toBe("segment one raw");
		expect(result.segments[1]!.reason).toBe("timeout");
	});

	test("one segment behaves exactly like the single-call path", async () => {
		const requests: QueuePolishRequest[] = [];
		const queue = createPolishQueue({
			timeoutMs: 500,
			call: (request) => {
				requests.push(request);
				return Promise.resolve(assistant("润色后的文本。"));
			},
		});
		queue.push(0, "润色前的文本");
		const result = await queue.finish();
		expect(result.text).toBe("润色后的文本。");
		expect(result.segments).toEqual([
			{ index: 0, status: "applied", text: "润色后的文本。", retried: false, latencyMs: expect.any(Number) },
		]);
		expect(result.polished).toBe(1);
		expect(result.failed).toBe(0);
		expect(result.retried).toBe(0);
		expect(requests).toHaveLength(1);
	});

	test("gates thinking per segment through the injected request", async () => {
		const requests: QueuePolishRequest[] = [];
		const queue = createPolishQueue({
			timeoutMs: 500,
			model: { reasoning: true },
			call: (request) => {
				requests.push(request);
				return Promise.resolve(assistant(`${requestedRaw(request)}。`));
			},
		});
		queue.push(0, "短句");
		queue.push(1, "长".repeat(THINKING_MAX_CHARS + 1));
		const result = await queue.finish();
		expect(result.failed).toBe(0);
		expect(requests).toHaveLength(2);
		expect(requests[0]).not.toHaveProperty("samplingParams");
		expect(requests[1]!.samplingParams).toEqual({ reasoning_effort: "none" });
	});
});
