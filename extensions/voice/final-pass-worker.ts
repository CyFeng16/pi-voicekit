import { existsSync } from "node:fs";
import { join } from "node:path";
import { parentPort } from "node:worker_threads";
import { LOCAL_MODELS } from "./local.ts";
import {
	clearRecognizerCache,
	getOrCreateRecognizer,
	initSherpa,
	getSherpaError,
	transcribeBufferSegmented,
} from "./sherpa-engine.ts";

export type FinalRequest =
	| { type: "init"; modelId: string; modelDir: string; language: string }
	| { type: "transcribe"; pcm: Uint8Array }
	| { type: "dispose" };
export type FinalResponse =
	| { type: "ready" }
	| { type: "segment"; text: string; index: number }
	| { type: "result"; text: string; hadSpeech: boolean }
	| { type: "failed"; message: string };

// The native handle never leaves this thread. Serializing also protects direct protocol consumers.
if (parentPort) {
	const port = parentPort;
	let recognizer: ReturnType<typeof getOrCreateRecognizer> | null = null;
	let failed = false;
	let chain = Promise.resolve();
	const send = (message: FinalResponse) => port.postMessage(message);
	async function handle(message: FinalRequest): Promise<void> {
		if (failed) return;
		try {
			switch (message.type) {
				case "init": {
					const model = LOCAL_MODELS.find((entry) => entry.id === message.modelId);
					if (!model) throw new Error(`Unknown model: ${message.modelId}`);
					for (const file of Object.values(model.sherpaModel.files)) {
						if (file && !existsSync(join(message.modelDir, file))) throw new Error(`Missing model file: ${file}`);
					}
					if (!(await initSherpa()))
						throw new Error(`sherpa-onnx could not be loaded: ${getSherpaError() || "unknown error"}`);
					recognizer = getOrCreateRecognizer(model, message.modelDir, message.language);
					send({ type: "ready" });
					return;
				}
				case "transcribe": {
					if (!recognizer) throw new Error("Final worker is not initialized");
					const text = await transcribeBufferSegmented(Buffer.from(message.pcm), recognizer, undefined, (text, index) =>
						send({ type: "segment", text, index })
					);
					send({ type: "result", text, hadSpeech: text.trim().length > 0 });
					return;
				}
				case "dispose":
					recognizer = null;
					clearRecognizerCache();
					port.close();
					return;
			}
		} catch (error) {
			failed = true;
			send({ type: "failed", message: error instanceof Error ? error.message : String(error) });
			recognizer = null;
			clearRecognizerCache();
			port.close();
		}
	}
	port.on("message", (message: FinalRequest) => {
		chain = chain.then(() => handle(message));
	});
}
