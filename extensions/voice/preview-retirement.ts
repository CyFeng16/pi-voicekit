import type { PreviewClient } from "./preview-worker-client.ts";
import type { PreviewSession } from "./preview-session.ts";

type RetiringClient = Pick<PreviewClient, "flushTimeoutMs" | "destroy">;

export interface PreviewRetirementDeps<Timer extends { unref?(): unknown }> {
	debug(message: string, details: { error: string }): void;
	safeErrorText(error: unknown): string;
	setTimeout(callback: () => void, delay: number): Timer;
	clearTimeout(timer: NoInfer<Timer> | undefined): void;
}

/** Own retired clients and the newest finish without coupling drains across recordings. */
export function createPreviewRetirement<Timer extends { unref?(): unknown }>(deps: PreviewRetirementDeps<Timer>) {
	const retiringPreviewClients = new Set<RetiringClient>();
	const previewRetirementTimers = new Map<RetiringClient, Timer>();
	let previewFinish: Promise<void> | null = null;

	function destroyRetiringPreviewClient(client: RetiringClient): void {
		if (!retiringPreviewClients.delete(client)) return;
		deps.clearTimeout(previewRetirementTimers.get(client));
		previewRetirementTimers.delete(client);
		void client.destroy().catch((error) => {
			deps.debug("preview destroy failed", { error: deps.safeErrorText(error) });
		});
	}

	function retirePreviewClient(client: RetiringClient, drain: Promise<void> | null): void {
		retiringPreviewClients.add(client);
		if (!drain) {
			destroyRetiringPreviewClient(client);
			return;
		}
		// Allow the flush deadline to release its claim first, but never orphan a hung drain.
		const timer = deps.setTimeout(() => destroyRetiringPreviewClient(client), client.flushTimeoutMs + 250);
		previewRetirementTimers.set(client, timer);
		timer.unref?.();
		void drain.then(
			() => destroyRetiringPreviewClient(client),
			() => destroyRetiringPreviewClient(client)
		);
	}

	function finishPreview(preview: Pick<PreviewSession, "finish">): Promise<void> {
		// A stop owns only this recording's drain, never an older recording's pending finish.
		const finishing = preview
			.finish()
			.catch((error) => deps.debug("preview finish failed", { error: deps.safeErrorText(error) }))
			.finally(() => {
				if (previewFinish === finishing) previewFinish = null;
			});
		previewFinish = finishing;
		return finishing;
	}

	return {
		retirePreviewClient,
		finishPreview,
		get finish() {
			return previewFinish;
		},
		set finish(value: Promise<void> | null) {
			previewFinish = value;
		},
		get size() {
			return retiringPreviewClients.size;
		},
		destroyRetiringClients() {
			for (const client of retiringPreviewClients) destroyRetiringPreviewClient(client);
		},
	};
}
