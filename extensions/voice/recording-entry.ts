import type { RecordingController, VoiceState } from "./recording-controller.ts";
import type { createRecordingOwner } from "./preview-entrypoint.ts";
import type { PreviewClient } from "./preview-worker-client.ts";

type RecordingOwner = ReturnType<typeof createRecordingOwner>;

/**
 * Borrow shared storage accessors from the entrypoint, which also provides the command surface.
 * The controller owns state and generation; the lifecycle module executes the recording flow.
 */
export interface RecordingEntryDeps<Context> {
	recordingController: RecordingController;
	debug(message: string): void;
	setState(state: VoiceState): void;
	abortPreview(): void;
	setOwner(owner: RecordingOwner): void;
	getContext(): Context;
	getConfig(): { previewEnabled?: boolean };
	resolvePreviewModelDir(enabled: boolean): string | null;
	createRecordingOwner(current: () => boolean): RecordingOwner;
	createPreviewClient(options: { previewModelDir: string | null }): PreviewClient;
	retirePreviewClient(client: PreviewClient, drain: Promise<void> | null): void;
	preview: {
		client: PreviewClient | null;
		modelDir: string | null;
		finish: Promise<void> | null;
	};
}

/** Prepare a recording and refresh preview availability before claiming its channel. */
export function startRecordingEntry<Context>(deps: RecordingEntryDeps<Context>) {
	deps.debug("startRecording called");
	deps.setState("recording");
	deps.abortPreview();
	const generation = deps.recordingController.begin();
	const current = () => deps.recordingController.owns(generation);
	const owner = deps.createRecordingOwner(current);
	deps.setOwner(owner);
	const recordingCtx = deps.getContext();
	const previewModelDir = deps.resolvePreviewModelDir(deps.getConfig().previewEnabled ?? true);
	const preview = deps.preview;
	const previousDrain = preview.finish ?? preview.client?.pendingDrain ?? null;
	if (preview.client && (previewModelDir !== preview.modelDir || previousDrain)) {
		const oldClient = preview.client;
		const previousFinish = previousDrain;
		preview.client = null;
		preview.modelDir = null;
		preview.finish = null;
		deps.retirePreviewClient(oldClient, previousFinish);
	}
	if (!preview.client) {
		preview.client = deps.createPreviewClient({ previewModelDir });
		preview.modelDir = previewModelDir;
	}
	return { generation, current, owner, recordingCtx, previewModelDir, previousDrain, client: preview.client };
}
