// tests/preview-catalogue.test.ts
//
// The catalogue gains one streaming entry that may only feed the display preview. The point of
// these tests is not the entry itself — it is that no path can turn it into `config.localModel`:
// a streaming model cannot produce the authoritative transcript, so activating it would fail every
// dictation. `finalModels()` is the single selector every final-model consumer routes through.
import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type VoiceConfig } from "../extensions/voice/config";
import { autoRecommendModel, getModelFitness, type DeviceProfile } from "../extensions/voice/device";
import {
	LOCAL_MODELS,
	PREVIEW_MODEL_ID,
	finalModels,
	previewModel,
	type LocalModelInfo,
} from "../extensions/voice/local";
import { formatBytes } from "../extensions/voice/model-download";
import { isRecogniserModelId, VoiceSettingsPanel, type PanelAction } from "../extensions/voice/settings-panel";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockDevice(overrides: Partial<DeviceProfile> = {}): DeviceProfile {
	return {
		platform: "linux",
		arch: "x64",
		totalRamMB: 16384,
		freeRamMB: 12000,
		cpuCores: 8,
		cpuModel: "test cpu",
		isRaspberryPi: false,
		gpu: { hasNvidia: false, hasMetal: false },
		isContainer: false,
		systemLocale: "en-US",
		...overrides,
	};
}

type Downloaded = { id: string; sizeMB: number };

const MODELS_TAB = 1;
const DOWNLOADED_TAB = 2;
const DEVICE_TAB = 4;

function makePanel(options: { tab: number; downloaded?: Downloaded[]; config?: VoiceConfig; installed?: boolean }): {
	panel: VoiceSettingsPanel;
	config: VoiceConfig;
	downloaded: Downloaded[];
	closed: PanelAction[];
} {
	const downloaded: Downloaded[] = options.downloaded ?? [];
	const config: VoiceConfig = options.config ?? { ...DEFAULT_CONFIG };
	const panel = new VoiceSettingsPanel(
		{
			config,
			device: mockDevice(),
			cwd: process.cwd(),
			getModelFitness,
			getDownloadedModels: () => downloaded,
			deleteModel: (id: string) => {
				const index = downloaded.findIndex((model) => model.id === id);
				if (index >= 0) downloaded.splice(index, 1);
				return index >= 0;
			},
			isSherpaAvailable: () => true,
			formatDeviceSummary: () => "test device",
			saveConfig: () => {},
			clearRecognizerCache: () => {},
			isModelInstalled: () => options.installed === true,
		},
		options.tab
	);
	const closed: PanelAction[] = [];
	panel.onClose = (action) => closed.push(action);
	return { panel, config, downloaded, closed };
}

/** The picker groups the panel actually built, flattened (top picks repeat a model on purpose). */
function pickerRows(panel: VoiceSettingsPanel): { id: string; role?: "final" | "preview" }[] {
	return ((panel as any).modelGroups as { rows: { id: string; role?: "final" | "preview" }[] }[]).flatMap(
		(group) => group.rows
	);
}

/** Move the cursor to the last selectable row (the preview affordance) and render. */
function renderLastRow(panel: VoiceSettingsPanel): string[] {
	panel.handleInput("\x1b[A"); // ↑ from row 0 wraps to the last row
	return panel.render(100);
}

// ─── The catalogue entry ─────────────────────────────────────────────────────

describe("the preview catalogue entry", () => {
	test("the preview entry is online, download-only, and excluded from the final picker", () => {
		expect(previewModel().sherpaModel.mode).toBe("online");
		expect(previewModel().role).toBe("preview");
		expect(previewModel().sherpaModel.downloadUrls.encoder).toContain("streaming-paraformer-bilingual-zh-en");
		expect(finalModels().some((m) => m.id === PREVIEW_MODEL_ID)).toBe(false);
		expect(finalModels()).toHaveLength(21);
		expect(LOCAL_MODELS.filter((m) => m.sherpaModel.mode === "online")).toHaveLength(1);
	});

	test("the entry carries the verified download layout and endpointing rules", () => {
		const model = previewModel();

		expect(model.id).toBe(PREVIEW_MODEL_ID);
		expect(model.size).toBe("226 MB");
		expect(model.sizeBytes).toBe(237_202_501);
		expect(model.runtimeRamMB).toBe(300);
		expect(model.langSupport).toBe("bilingual-zh-en");
		expect(model.sherpaModel.files).toEqual({
			encoder: "encoder.int8.onnx",
			decoder: "decoder.int8.onnx",
			tokens: "tokens.txt",
		});
		for (const url of Object.values(model.sherpaModel.downloadUrls)) {
			expect(url).toStartWith("https://huggingface.co/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/");
		}
		expect(model.sherpaModel.endpointing).toEqual({
			enableEndpoint: true,
			rule2MinTrailingSilence: 1.2,
			rule3MinUtteranceLength: 600,
		});
	});

	test("the 21 existing entries stay offline and final, untouched", () => {
		expect(LOCAL_MODELS).toHaveLength(22);
		for (const model of finalModels()) {
			expect(model.role ?? "final").toBe("final");
			expect(model.sherpaModel.mode ?? "offline").toBe("offline");
		}
		// `previewModel()` is the only consumer of the streaming entry, and it is not a final model.
		expect(finalModels().map((model) => model.id)).not.toContain(PREVIEW_MODEL_ID);
	});
});

// ─── Guard 1: isRecogniserModelId ────────────────────────────────────────────

describe("isRecogniserModelId", () => {
	test("refuses the preview id and accepts a final id", () => {
		expect(isRecogniserModelId(PREVIEW_MODEL_ID)).toBe(false);
		expect(isRecogniserModelId("parakeet-v3")).toBe(true);
		expect(isRecogniserModelId("not-a-catalogue-entry")).toBe(false);
	});
});

// ─── Guard 2: the Models tab — 21 final rows plus one preview affordance ─────

describe("the Models tab", () => {
	test("still offers exactly the 21 final models", () => {
		const { panel } = makePanel({ tab: MODELS_TAB });
		const rows = pickerRows(panel);

		const finalIds = new Set(rows.filter((row) => row.role !== "preview").map((row) => row.id));
		expect(finalIds.size).toBe(21);
		expect(finalIds.has(PREVIEW_MODEL_ID)).toBe(false);
		// The preview entry appears once, as its own affordance row.
		expect(rows.filter((row) => row.id === PREVIEW_MODEL_ID)).toHaveLength(1);
	});

	test("renders the preview row as not installed when the model is absent", () => {
		const { panel } = makePanel({ tab: MODELS_TAB, installed: false });
		const lines = renderLastRow(panel);
		const row = lines.find((line) => line.includes(previewModel().name));

		expect(row).toBeDefined();
		expect(row!).toContain("not installed");
		expect(row!).not.toContain("active");
	});

	test("renders the preview row as installed when the model is present", () => {
		const { panel } = makePanel({ tab: MODELS_TAB, installed: true });
		const lines = renderLastRow(panel);
		const row = lines.find((line) => line.includes(previewModel().name));

		expect(row).toBeDefined();
		expect(row!).toContain("installed");
		expect(row!).not.toContain("not installed");
	});

	test("renders the preview row through the real disk check when no predicate is injected", () => {
		// No `isModelInstalled` seam: the row goes through `isModelDownloaded` and the model dir.
		// The fixture is a directory with no files — the state a partial download leaves behind.
		// `isModelDownloaded` names files from the URL map, so handing it bare file names throws
		// `"encoder.int8.onnx" cannot be parsed as a URL` exactly in this state.
		const home = mkdtempSync(join(tmpdir(), "pi-voice-preview-catalogue-"));
		const homeSpy = spyOn(os, "homedir").mockReturnValue(home);
		try {
			mkdirSync(join(home, ".pi", "models", PREVIEW_MODEL_ID), { recursive: true });

			const config: VoiceConfig = { ...DEFAULT_CONFIG };
			const panel = new VoiceSettingsPanel(
				{
					config,
					device: mockDevice(),
					cwd: process.cwd(),
					getModelFitness,
					getDownloadedModels: () => [],
					deleteModel: () => false,
					isSherpaAvailable: () => true,
					formatDeviceSummary: () => "test device",
					saveConfig: () => {},
					clearRecognizerCache: () => {},
				},
				MODELS_TAB
			);

			const row = renderLastRow(panel).find((line) => line.includes(previewModel().name));
			expect(row).toBeDefined();
			expect(row!).toContain("not installed");
		} finally {
			homeSpy.mockRestore();
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("selecting the absent preview row asks for the download and never activates it", () => {
		const { panel, config, closed } = makePanel({ tab: MODELS_TAB, installed: false });

		panel.handleInput("\x1b[A"); // to the preview row
		panel.handleInput("\r");

		expect(closed).toEqual([{ type: "download", modelId: PREVIEW_MODEL_ID }]);
		expect(config.localModel).toBeUndefined();
	});

	test("selecting the installed preview row is a no-op for the active model", () => {
		const { panel, config, closed } = makePanel({ tab: MODELS_TAB, installed: true });

		panel.handleInput("\x1b[A");
		panel.handleInput("\r");

		expect(closed).toEqual([]);
		expect(config.localModel).toBeUndefined();
	});
});

// ─── Guard 3: the Downloaded tab cannot activate it ─────────────────────────

describe("the Downloaded tab", () => {
	test("lists the preview directory but ↵ on it does not become the active model", () => {
		const { panel, config } = makePanel({
			tab: DOWNLOADED_TAB,
			downloaded: [
				{ id: PREVIEW_MODEL_ID, sizeMB: 226 },
				{ id: "parakeet-v3", sizeMB: 671 },
			],
		});

		// Routed to the preview slot: the row says so and never says "active".
		const previewRow = panel.render(100).find((line) => line.includes(previewModel().name));
		expect(previewRow).toBeDefined();
		expect(previewRow!).toContain("preview only");
		expect(previewRow!).not.toContain("active");

		panel.handleInput("\r"); // row 0 — the preview model
		expect(config.localModel).toBeUndefined();

		panel.handleInput("\x1b[B"); // row 1 — a final model
		panel.handleInput("\r");
		expect(config.localModel).toBe("parakeet-v3");
	});

	test("the post-delete fallback cannot select it", () => {
		const { panel, config, downloaded } = makePanel({
			tab: DOWNLOADED_TAB,
			downloaded: [
				{ id: "paraformer-zh", sizeMB: 238 },
				{ id: PREVIEW_MODEL_ID, sizeMB: 226 },
			],
		});
		config.localModel = "paraformer-zh";

		panel.handleInput("x"); // arm
		panel.handleInput("x"); // commit

		expect(downloaded.map((model) => model.id)).toEqual([PREVIEW_MODEL_ID]);
		expect(config.localModel).toBeUndefined();
	});
});

// ─── Guard 4: the recommendation path ───────────────────────────────────────

describe("autoRecommendModel over the final set", () => {
	test("never returns the preview id, whatever the language or device", () => {
		const devices: DeviceProfile[] = [
			mockDevice({ totalRamMB: 4096, freeRamMB: 2048 }),
			mockDevice({ totalRamMB: 32768, freeRamMB: 24000 }),
			mockDevice({ totalRamMB: 1024, freeRamMB: 512, isRaspberryPi: true }),
		];

		for (const device of devices) {
			for (const language of ["zh", "en", "ja", "ru", "ko"]) {
				const recommended = autoRecommendModel(finalModels(), device, language);
				expect(recommended?.id).not.toBe(PREVIEW_MODEL_ID);
				if (recommended) expect(isRecogniserModelId(recommended.id)).toBe(true);
			}
		}
	});
});

// ─── Guard 5: onboarding only ever sees final models ────────────────────────

describe("onboarding model pickers", () => {
	test("route through finalModels(), never the raw catalogue", () => {
		// Four consumers in `onboarding.ts` used to read `LOCAL_MODELS` directly: the language
		// display helper, the fuzzy picker, `autoRecommendModel` and the confirm summary. A
		// single `LOCAL_MODELS` reference would let the streaming entry become `config.localModel`.
		const source = readFileSync(join(import.meta.dir, "..", "extensions", "voice", "onboarding.ts"), "utf8");

		expect(source).toContain("finalModels()");
		expect(source).not.toContain("LOCAL_MODELS");
	});
});

// ─── The device hint is computed over final models ──────────────────────────

describe("the Device tab", () => {
	test("advertises the free space needed by the largest final model", () => {
		const largest: LocalModelInfo = finalModels().reduce((a, b) => (a.sizeBytes > b.sizeBytes ? a : b));
		const { panel } = makePanel({ tab: DEVICE_TAB });
		const lines = panel.render(100);
		const row = lines.find((line) => line.includes("Disk space"));

		// Smoke check: with today's catalogue the preview entry is not the largest, so this line
		// matches either way; it pins the hint to a byte figure rather than an entry name.
		expect(row).toBeDefined();
		expect(row!).toContain(formatBytes(largest.sizeBytes));
	});
});
