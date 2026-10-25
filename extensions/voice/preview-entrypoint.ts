import { previewModel } from "./local";
import { getModelDir, isModelDownloaded } from "./model-download";

/** Presence is silent: never hand bare filenames to the URL-based download helper. */
export function resolvePreviewModelDir(
	enabled: boolean,
	installed = isModelDownloaded,
	directory = getModelDir
): string | null {
	if (!enabled) return null;
	const model = previewModel();
	return installed(model.id, model.sherpaModel.downloadUrls) ? directory(model.id) : null;
}

/** One stop and one delivery per generation; cancellation wins even during the preview drain. */
export function createRecordingOwner(isCurrent: () => boolean) {
	let cancelled = false;
	let stopping = false;
	let delivered = false;
	return {
		cancel() {
			cancelled = true;
		},
		deliver(): boolean {
			if (cancelled || delivered || !isCurrent()) return false;
			delivered = true;
			return true;
		},
		async stop(final: () => Promise<void>, drain: () => Promise<void>): Promise<void> {
			if (cancelled || stopping || delivered || !isCurrent()) return;
			stopping = true;
			const result = final();
			void drain().catch(() => {});
			await result;
		},
	};
}
