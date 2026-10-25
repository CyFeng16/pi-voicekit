// Adapter only: ordering and ownership run in the imported production entry function.
export const recordingEntryCall = `
const { generation, current, owner, recordingCtx, previewModelDir, previousDrain } = startRecordingEntry({
	recordingController, debug: voiceDebug, setState: setVoiceState,
	getConfig: () => config, getContext: () => ctx,
	abortPreview: () => activePreview?.abort(),
	setOwner: value => { recordingOwner = value; },
	resolvePreviewModelDir, createPreviewClient, createRecordingOwner, retirePreviewClient,
	preview: {
		get client() { return previewClient; }, set client(value) { previewClient = value; },
		get modelDir() { return previewClientModelDir; }, set modelDir(value) { previewClientModelDir = value; },
		get finish() { return previewFinish; }, set finish(value) { previewFinish = value; }
	}
});
`;
export const recordingPreamble = `async function startRecording() { ${recordingEntryCall}`;
