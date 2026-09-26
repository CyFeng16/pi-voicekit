/**
 * The model call, injected into the pass.
 *
 * `polishTranscript` takes its caller as a parameter, so the evaluation needs no
 * Pi runtime at all. Two callers exist:
 *
 * - A deterministic fake, which reads the transcript out of the real request the
 *   prompt builder produced and returns a scripted answer. It exercises the whole
 *   pipeline offline, which is how the scorer is validated before any money is
 *   spent - and it can be told to fail on purpose, so the fallback paths are
 *   measurable rather than assumed.
 * - An OpenAI-compatible HTTP caller for real numbers. It refuses to run without
 *   an explicit base URL, model and network permission, and it never logs the key.
 *
 * Spec: docs/superpowers/specs/2026-09-26-stt-post-processing-design.md (4.9)
 */
import type { AssistantLike, PolishCaller, PolishRequest } from "../../extensions/voice/post-process";

export interface FakeCallerOptions {
	/** Exact raw -> corrected pairs; unmatched transcripts come back unchanged. */
	map?: Record<string, string>;
	/** Substitutions applied to every transcript, in order. */
	table?: [string, string][];
	/** Return this transcript for every call, to prove the metrics can move. */
	always?: string;
	/** Fail on purpose so the fallback paths are exercised. */
	fail?: "timeout" | "error" | "rejected-status" | "empty";
	/** How many calls to let succeed before failing; omitted means fail immediately. */
	succeedFirst?: number;
}

/** The raw transcript as the prompt builder wrapped it. */
export function extractTranscript(request: PolishRequest): string {
	const last = request.messages[request.messages.length - 1];
	const text = typeof last?.content === "string" ? last.content : "";
	const match = /<TRANSCRIPT>\n([\s\S]*?)\n<\/TRANSCRIPT>/.exec(text);
	return match ? (match[1] ?? "") : text;
}

/** Everything the prompt asked the model to treat as reference, for assertions. */
export function extractContextBlock(request: PolishRequest): string {
	const last = request.messages[request.messages.length - 1];
	const text = typeof last?.content === "string" ? last.content : "";
	const match = /<CONTEXT(?:_SUMMARY)?>[\s\S]*?<\/(?:CONTEXT|CONTEXT_SUMMARY)>/.exec(text);
	return match ? match[0] : "";
}

export function fakeCaller(options: FakeCallerOptions = {}): PolishCaller {
	let calls = 0;
	return async (request: PolishRequest, signal: AbortSignal): Promise<AssistantLike> => {
		calls += 1;
		const failing = options.fail !== undefined && calls > (options.succeedFirst ?? 0);
		if (failing) {
			if (options.fail === "timeout") {
				// A provider that ignores the abort signal: the pass must still time out.
				return new Promise<AssistantLike>((_, reject) => {
					signal.addEventListener("abort", () => {
						/* deliberately ignored */
					});
					setTimeout(() => reject(new Error("fake caller never answered")), 60_000);
				});
			}
			if (options.fail === "error") throw new Error("fake caller failure");
			if (options.fail === "rejected-status") {
				return { stopReason: "length", content: [{ type: "text", text: "truncated" }] };
			}
			return { stopReason: "stop", content: [{ type: "text", text: "   " }] };
		}
		const transcript = extractTranscript(request);
		let text = options.always ?? transcript;
		if (options.map?.[transcript] !== undefined) text = options.map[transcript] as string;
		for (const [from, to] of options.table ?? []) text = text.split(from).join(to);
		return { stopReason: "stop", content: [{ type: "text", text }] };
	};
}

export interface OpenAiCallerOptions {
	baseUrl?: string;
	apiKey?: string;
	model?: string;
	/** Extra options merged into the request body (temperature defaults to 0). */
	body?: Record<string, unknown>;
}

export const NETWORK_ENV = {
	baseUrl: "POLISH_EVAL_BASE_URL",
	apiKey: "POLISH_EVAL_API_KEY",
	model: "POLISH_EVAL_MODEL",
} as const;

export interface ResolvedCaller {
	caller: PolishCaller;
	/** Safe to print: no credential ever appears here. */
	description: string;
	modelRef: string;
	usesNetwork: boolean;
}

export interface CallerResolutionError {
	error: string;
}

/**
 * Build the real caller from explicit options or the documented environment
 * variables. The key is only ever read here and only ever sent in a header.
 */
export function openAiCompatibleCaller(options: OpenAiCallerOptions = {}): PolishCaller {
	const baseUrl = options.baseUrl?.replace(/\/$/, "");
	const model = options.model;
	const apiKey = options.apiKey;
	if (!baseUrl) throw new Error("missing base URL (--base-url or POLISH_EVAL_BASE_URL)");
	if (!model) throw new Error("missing model (--model or POLISH_EVAL_MODEL)");
	return async (request: PolishRequest): Promise<AssistantLike> => {
		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
			},
			body: JSON.stringify({
				model,
				messages: [
					{ role: "system", content: request.systemPrompt },
					...request.messages.map((message) => ({ role: message.role, content: message.content })),
				],
				max_tokens: request.maxTokens,
				temperature: 0,
				...options.body,
			}),
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new Error(`provider returned ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
		}
		const payload = (await response.json()) as {
			choices?: { message?: { content?: unknown }; finish_reason?: string }[];
		};
		const choice = payload.choices?.[0];
		const content = choice?.message?.content;
		const text = typeof content === "string" ? content : "";
		const finish = choice?.finish_reason;
		return {
			stopReason: finish === undefined || finish === "stop" ? "stop" : finish,
			content: [{ type: "text", text }],
		};
	};
}

export function resolveCaller(
	kind: string,
	options: OpenAiCallerOptions = {},
	env: Record<string, string | undefined> = process.env
): ResolvedCaller | CallerResolutionError {
	if (kind === "fake") {
		return {
			caller: fakeCaller(options.body ? {} : {}),
			description: "deterministic fake (no network)",
			modelRef: "fake",
			usesNetwork: false,
		};
	}
	const baseUrl = options.baseUrl ?? env[NETWORK_ENV.baseUrl];
	const apiKey = options.apiKey ?? env[NETWORK_ENV.apiKey];
	const model = options.model ?? env[NETWORK_ENV.model];
	const configured = [baseUrl ? "base URL" : undefined, model ? "model" : undefined, apiKey ? "key" : undefined]
		.filter(Boolean)
		.join(", ");
	return {
		caller: openAiCompatibleCaller({ baseUrl, apiKey, model }),
		description: `openai-compatible (network; configured: ${configured || "nothing"})`,
		modelRef: model ?? "unset",
		usesNetwork: true,
	};
}
