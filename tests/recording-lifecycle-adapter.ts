// Argument adapter for command/hold slices that remain until Task 9. No lifecycle ordering lives here.
export const lifecycleAdapter = `
const { startRecording, stopVoiceRecording } = createRecordingLifecycle({
	state: {
		get config() { return config; }, get ctx() { return ctx; },
		get activeSession() { return activeSession; }, set activeSession(value) { activeSession = value; },
		get activePreview() { return activePreview; }, set activePreview(value) { activePreview = value; },
		get recordingOwner() { return recordingOwner; }, set recordingOwner(value) { recordingOwner = value; },
		get statusTimer() { return statusTimer; }, set statusTimer(value) { statusTimer = value; },
		get lastStopTime() { return lastStopTime; }, set lastStopTime(value) { lastStopTime = value; },
		get recordingStart() { return recordingStart; },
		get kittyReleaseDetected() { return kittyReleaseDetected; }, get spaceDownTime() { return spaceDownTime; }
	},
	entry: {
		recordingController, debug: voiceDebug, setState: setVoiceState,
		getConfig: () => config, getContext: () => ctx,
		abortPreview: () => activePreview?.abort(), setOwner: value => { recordingOwner = value; },
		resolvePreviewModelDir, createPreviewClient, createRecordingOwner, retirePreviewClient,
		preview: {
			get client() { return previewClient; }, set client(value) { previewClient = value; },
			get modelDir() { return previewClientModelDir; }, set modelDir(value) { previewClientModelDir = value; },
			get finish() { return previewRetirement.finish; }, set finish(value) { previewRetirement.finish = value; }
		}
	},
	recordingController, voiceDebug, setVoiceState, clearRecordingAnimTimer, clearWarmupWidget,
	hideWidget, showRecordingWidget, playSound, resetHoldState, cancelDelayedStop,
	resetReleaseDetect() {}, updateAudioLevel, updateVoiceStatus, punctuateTranscript, addToHistory,
	finishPreview, detectAudioCaptureTool, spawn, startLocalSession, stopLocalSession, finalModels,
	setInterval, clearInterval, now: Date.now,
	getOrInitVoiceUi: () => ({ ticker: { subscribe: () => () => {} } })
});
`;
