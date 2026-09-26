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

	test("retries a timed-out segment once with thinking off", async () => {
		const requests: QueuePolishRequest[] = [];
		const queue = createPolishQueue({
			timeoutMs: 20,
			model: { reasoning: true },
			call: (request) => {
				requests.push(request);
				// The first attempt hangs even though its text is short enough for thinking, so the
				// retry has to be visible in the request itself, not inferred from the outcome.
				if (requests.length === 1) return new Promise<AssistantLike>(() => {});
				return Promise.resolve(assistant("重试后的文本"));
			},
		});
		queue.push(0, "短句重试");
		const result = await queue.finish();
		expect(requests).toHaveLength(2);
		expect(requests[0]).not.toHaveProperty("samplingParams");
		expect(requests[1]!.samplingParams).toEqual({ reasoning_effort: "none" });
		expect(result.segments[0]).toMatchObject({ status: "applied", retried: true });
		expect(result.text).toBe("重试后的文本");
		expect(result.retried).toBe(1);
		expect(result.failed).toBe(0);
	});

	test("retries once when the transport fails outright", async () => {
		const requests: QueuePolishRequest[] = [];
		const queue = createPolishQueue({
			timeoutMs: 200,
			call: (request) => {
				requests.push(request);
				if (requests.length === 1) return Promise.reject(new Error("socket closed"));
				return Promise.resolve(assistant("重试成功"));
			},
		});
		queue.push(0, "调用失败");
		const result = await queue.finish();
		expect(requests).toHaveLength(2);
		expect(result.text).toBe("重试成功");
		expect(result.retried).toBe(1);
	});

	test("does not retry a guardrail rejection", async () => {
		const requests: QueuePolishRequest[] = [];
		const queue = createPolishQueue({
			timeoutMs: 200,
			model: { reasoning: true },
			call: (request) => {
				requests.push(request);
				// A non-stop finish is a wrong rewrite, not a slow one: repeating it cannot help.
				return Promise.resolve(assistant("", { stopReason: "error" }));
			},
		});
		queue.push(0, "guardrail 段的原文");
		const result = await queue.finish();
		expect(requests).toHaveLength(1);
		expect(result.segments[0]!.status).toBe("fallback");
		expect(result.segments[0]!.retried).toBe(false);
		expect(result.text).toBe("guardrail 段的原文");
		expect(result.retried).toBe(0);
	});

	test("never lets a caller that ignores the abort signal exceed the cap", async () => {
		let started = 0;
		let live = 0;
		let peak = 0;
		const queue = createPolishQueue({
			timeoutMs: 10,
			model: { reasoning: true },
			call: () => {
				started += 1;
				live += 1;
				peak = Math.max(peak, live);
				// A hung endpoint that ignores the signal: the timeout must fall the segment back
				// without freeing its slot, or a long dictation piles up requests past the cap.
				return new Promise<AssistantLike>(() => {});
			},
		});
		for (let index = 0; index < 6; index += 1) queue.push(index, `hanging segment ${index}`);
		const result = await queue.finish();
		expect(peak).toBe(POLISH_QUEUE_CONCURRENCY);
		expect(started).toBe(POLISH_QUEUE_CONCURRENCY);
		expect(live).toBe(POLISH_QUEUE_CONCURRENCY);
		expect(result.polished).toBe(0);
		expect(result.failed).toBe(6);
		// No slot can free, so a retry would only wait: those segments fall back instead.
		expect(result.retried).toBe(0);
		expect(result.text).toBe(
			"hanging segment 0 hanging segment 1 hanging segment 2 hanging segment 3 hanging segment 4 hanging segment 5"
		);
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

	test("stops issuing requests once the pass is invalidated", async () => {
		let current = true;
		const requests: string[] = [];
		const releases: (() => void)[] = [];
		const queue = createPolishQueue({
			timeoutMs: 500,
			concurrency: 1,
			isCurrent: () => current,
			call: (request) => {
				requests.push(requestedRaw(request));
				return new Promise<AssistantLike>((resolve) => {
					releases.push(() => resolve(assistant(`P-${requestedRaw(request)}`)));
				});
			},
		});
		queue.push(0, "RAW-0");
		queue.push(1, "RAW-1");
		queue.push(2, "RAW-2");
		expect(requests).toEqual(["RAW-0"]);
		// The first request is already out and answers; the pass dies before the next segment can
		// take its slot, so the remaining segments must never reach the caller.
		current = false;
		releases.shift()?.();
		const result = await queue.finish();
		expect(requests).toEqual(["RAW-0"]);
		// The first answer arrived after invalidation, so it is inert too: no segment writes
		// polished text once the pass has lost ownership.
		expect(result.segments.map((segment) => segment.status)).toEqual(["fallback", "fallback", "fallback"]);
		expect(result.segments[0]).toMatchObject({ text: "RAW-0", reason: "invalidated", retried: false });
		expect(result.segments[1]).toMatchObject({ text: "RAW-1", reason: "invalidated", retried: false });
		expect(result.segments[2]).toMatchObject({ text: "RAW-2", reason: "invalidated", retried: false });
	});

	test("does not retry a timed-out segment once the pass is invalidated", async () => {
		let current = true;
		let calls = 0;
		const queue = createPolishQueue({
			timeoutMs: 20,
			isCurrent: () => current,
			call: () => {
				calls += 1;
				// The pass dies while the first attempt burns its deadline: no retry may be scheduled.
				current = false;
				return new Promise<AssistantLike>(() => {});
			},
		});
		queue.push(0, "取消中的段");
		const result = await queue.finish();
		expect(calls).toBe(1);
		expect(result.segments[0]).toMatchObject({ status: "fallback", text: "取消中的段", retried: false });
		expect(result.segments[0]!.reason).toBe("invalidated");
		expect(result.retried).toBe(0);
	});
});
