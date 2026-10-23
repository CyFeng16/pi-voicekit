import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { VoiceConfig, VoiceSettingsScope } from "./config";
import { LOCAL_MODELS, getLanguagesForLocalModel, type LocalLangEntry, type LocalModelInfo } from "./local";
import {
	detectDevice,
	autoRecommendModel,
	getModelFitness,
	formatDeviceSummary,
	localeToLanguageCode,
	type ModelFitness,
} from "./device";

type VoiceUiContext = ExtensionContext | ExtensionCommandContext;

/** Escape a value for safe use inside single-quoted shell strings. */
export function shellEscapeSingleQuoted(value: string): string {
	// In single-quoted strings, the only special char is the single quote itself.
	// Replace ' with '"'"' (end single-quote, double-quote a single-quote, restart single-quote).
	return value.replace(/'/g, `'"'"'`);
}

export interface OnboardingResult {
	config: VoiceConfig;
	selectedScope: VoiceSettingsScope;
	summaryLines: string[];
}

export interface FirstRunDecision {
	action: "start" | "later";
}

function formatLangOption(l: LocalLangEntry): string {
	return `${l.name} (${l.code})`;
}

/** Extract language code from "Language Name (code)" format */
export function extractLanguageCode(selection: string): string {
	const match = selection.match(/\(([^)]+)\)$/);
	return match ? match[1] : "en";
}

/** Find display name for a language code, resolved against the local model language catalogs. */
export function languageDisplayName(code: string): string {
	for (const model of LOCAL_MODELS) {
		const { languages } = getLanguagesForLocalModel(model.id);
		const entry = languages.find((l) => l.code === code);
		if (entry) return `${entry.name} (${entry.code})`;
	}
	return code;
}

/** Show language picker with fuzzy search — uses ctx.ui.custom() for real-time filtering.
 *  `languages` is the candidate list, derived from the selected local model. */
export async function pickLanguage(
	ctx: VoiceUiContext,
	currentCode: string,
	languages: LocalLangEntry[]
): Promise<string | undefined> {
	const { Container, Input, Spacer, Text, fuzzyFilter, getKeybindings } = await import("@earendil-works/pi-tui");

	const current = languageDisplayName(currentCode);
	const popular = languages.filter((l) => l.popular);
	const allItems = languages.map((l) => ({ ...l, label: formatLangOption(l) }));

	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const container = new Container();
		const searchInput = new Input();
		const listContainer = new Container();

		let filtered = allItems;
		let selectedIndex = 0;

		function updateList() {
			listContainer.clear();
			const maxVisible = 12;
			const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), filtered.length - maxVisible));
			const end = Math.min(start + maxVisible, filtered.length);

			// Popular header when no search query
			if (!searchInput.getValue()) {
				listContainer.addChild(new Text(theme.fg("muted", "  Popular:"), 0, 0));
				for (let i = 0; i < popular.length && i < end; i++) {
					const item = filtered[i];
					if (!item) continue;
					const isSelected = i === selectedIndex;
					const isCurrent = item.code === currentCode;
					const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
					const text = isSelected ? theme.fg("accent", item.label) : item.label;
					const check = isCurrent ? theme.fg("success", " ✓") : "";
					listContainer.addChild(new Text(`${prefix}${text}${check}`, 0, 0));
				}
				if (filtered.length > popular.length) {
					listContainer.addChild(new Text(theme.fg("muted", "  ───────────────────"), 0, 0));
					for (let i = popular.length; i < end; i++) {
						const item = filtered[i];
						if (!item) continue;
						const isSelected = i === selectedIndex;
						const isCurrent = item.code === currentCode;
						const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
						const text = isSelected ? theme.fg("accent", item.label) : item.label;
						const check = isCurrent ? theme.fg("success", " ✓") : "";
						listContainer.addChild(new Text(`${prefix}${text}${check}`, 0, 0));
					}
				}
			} else {
				// Search results
				for (let i = start; i < end; i++) {
					const item = filtered[i];
					if (!item) continue;
					const isSelected = i === selectedIndex;
					const isCurrent = item.code === currentCode;
					const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
					const text = isSelected ? theme.fg("accent", item.label) : item.label;
					const check = isCurrent ? theme.fg("success", " ✓") : "";
					listContainer.addChild(new Text(`${prefix}${text}${check}`, 0, 0));
				}
			}

			if (filtered.length === 0) {
				listContainer.addChild(new Text(theme.fg("muted", "  No matching languages"), 0, 0));
			} else if (start > 0 || end < filtered.length) {
				listContainer.addChild(new Text(theme.fg("muted", `  (${selectedIndex + 1}/${filtered.length})`), 0, 0));
			}

			tui.requestRender();
		}

		function filterList(query: string) {
			if (!query) {
				filtered = allItems;
			} else {
				filtered = fuzzyFilter(allItems, query, (item) => `${item.name} ${item.code}`);
			}
			selectedIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1));
			updateList();
		}

		// Build UI
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("accent", `Voice language (current: ${current})`), 1, 0));
		container.addChild(
			new Text(theme.fg("muted", "Type to search, ↑↓ to navigate, Enter to select, Esc to cancel"), 1, 0)
		);
		container.addChild(new Spacer(1));
		container.addChild(searchInput);
		container.addChild(new Spacer(1));
		container.addChild(listContainer);
		container.addChild(new Spacer(1));

		updateList();

		const kb = getKeybindings();
		(container as any).handleInput = (keyData: string) => {
			if (kb.matches(keyData, "tui.select.up")) {
				if (filtered.length === 0) return;
				selectedIndex = selectedIndex === 0 ? filtered.length - 1 : selectedIndex - 1;
				updateList();
			} else if (kb.matches(keyData, "tui.select.down")) {
				if (filtered.length === 0) return;
				selectedIndex = selectedIndex === filtered.length - 1 ? 0 : selectedIndex + 1;
				updateList();
			} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
				const item = filtered[selectedIndex];
				done(item ? item.code : undefined);
			} else if (kb.matches(keyData, "tui.select.cancel")) {
				done(undefined);
			} else {
				searchInput.handleInput(keyData);
				filterList(searchInput.getValue());
			}
		};

		// Focusable for IME
		Object.defineProperty(container, "focused", {
			get: () => (searchInput as any).focused,
			set: (v: boolean) => {
				(searchInput as any).focused = v;
			},
		});

		return container;
	});
}

export function finalizeOnboardingConfig(
	config: VoiceConfig,
	options: { validated: boolean; source: "first-run" | "setup-command" }
): VoiceConfig {
	if (options.validated) {
		const timestamp = new Date().toISOString();
		return {
			...config,
			onboarding: {
				...config.onboarding,
				completed: true,
				schemaVersion: config.version,
				completedAt: timestamp,
				lastValidatedAt: timestamp,
				source: options.source,
				skippedAt: undefined,
			},
		};
	}

	return {
		...config,
		onboarding: {
			...config.onboarding,
			completed: false,
			schemaVersion: config.version,
			completedAt: undefined,
			lastValidatedAt: undefined,
			source: "repair",
			skippedAt: undefined,
		},
	};
}

export async function promptFirstRunOnboarding(ctx: VoiceUiContext): Promise<FirstRunDecision> {
	const choice = await ctx.ui.select("Set up pi-voicekit now?", ["Start voice setup", "Remind me later"]);

	return { action: choice === "Start voice setup" ? "start" : "later" };
}

/**
 * Pick a local model using fuzzy search — device-aware with fitness badges.
 * Shows recommended models first, with color-coded fitness indicators.
 */
export async function pickLocalModel(
	ctx: VoiceUiContext,
	currentModelId: string | undefined,
	language: string
): Promise<LocalModelInfo | undefined> {
	const { Container, Input, Spacer, Text, fuzzyFilter, getKeybindings } = await import("@earendil-works/pi-tui");

	const device = detectDevice();
	const allItems = LOCAL_MODELS.map((m) => {
		const fitness = getModelFitness(m, device);
		const badge = fitnessLabel(fitness);
		return {
			...m,
			fitness,
			label: `${m.name} — ${m.size} ${badge} (${m.notes})`,
		};
	});

	// Sort: recommended → compatible → warning → incompatible, then by size (larger = more accurate)
	const fitnessOrder: Record<ModelFitness, number> = { recommended: 0, compatible: 1, warning: 2, incompatible: 3 };
	allItems.sort((a, b) => {
		const fitDiff = fitnessOrder[a.fitness] - fitnessOrder[b.fitness];
		if (fitDiff !== 0) return fitDiff;
		return b.sizeBytes - a.sizeBytes;
	});

	return ctx.ui.custom<LocalModelInfo | undefined>((tui, theme, _keybindings, done) => {
		const container = new Container();
		const searchInput = new Input();
		const listContainer = new Container();

		let filtered = allItems;
		let selectedIndex = 0;

		function updateList() {
			listContainer.clear();
			const maxVisible = 14;
			const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), filtered.length - maxVisible));
			const end = Math.min(start + maxVisible, filtered.length);

			for (let i = start; i < end; i++) {
				const item = filtered[i];
				if (!item) continue;
				const isSelected = i === selectedIndex;
				const isCurrent = item.id === currentModelId;
				const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
				const nameText = isSelected ? theme.fg("accent", item.name) : item.name;
				const sizeText = theme.fg("muted", ` — ${item.size}`);
				const badge = fitnessThemeBadge(item.fitness, theme);
				const notes = theme.fg("muted", ` (${item.notes})`);
				const check = isCurrent ? theme.fg("success", " ✓") : "";
				listContainer.addChild(new Text(`${prefix}${nameText}${sizeText} ${badge}${notes}${check}`, 0, 0));
			}

			if (filtered.length === 0) {
				listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
			} else if (start > 0 || end < filtered.length) {
				listContainer.addChild(new Text(theme.fg("muted", `  (${selectedIndex + 1}/${filtered.length})`), 0, 0));
			}

			tui.requestRender();
		}

		function filterList(query: string) {
			if (!query) {
				filtered = allItems;
			} else {
				filtered = fuzzyFilter(allItems, query, (item) => `${item.name} ${item.id} ${item.notes} ${item.langSupport}`);
			}
			selectedIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1));
			updateList();
		}

		// Build UI
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("accent", `Choose local model (${formatDeviceSummary(device)})`), 1, 0));
		container.addChild(
			new Text(theme.fg("muted", "Type to search, ↑↓ to navigate, Enter to select, Esc to cancel"), 1, 0)
		);
		container.addChild(new Spacer(1));
		container.addChild(searchInput);
		container.addChild(new Spacer(1));
		container.addChild(listContainer);
		container.addChild(new Spacer(1));

		updateList();

		const kb = getKeybindings();
		(container as any).handleInput = (keyData: string) => {
			if (kb.matches(keyData, "tui.select.up")) {
				if (filtered.length === 0) return;
				selectedIndex = selectedIndex === 0 ? filtered.length - 1 : selectedIndex - 1;
				updateList();
			} else if (kb.matches(keyData, "tui.select.down")) {
				if (filtered.length === 0) return;
				selectedIndex = selectedIndex === filtered.length - 1 ? 0 : selectedIndex + 1;
				updateList();
			} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
				const item = filtered[selectedIndex];
				done(item ? LOCAL_MODELS.find((m) => m.id === item.id) : undefined);
			} else if (kb.matches(keyData, "tui.select.cancel")) {
				done(undefined);
			} else {
				searchInput.handleInput(keyData);
				filterList(searchInput.getValue());
			}
		};

		Object.defineProperty(container, "focused", {
			get: () => (searchInput as any).focused,
			set: (v: boolean) => {
				(searchInput as any).focused = v;
			},
		});

		return container;
	});
}

/** Fitness label for display */
function fitnessLabel(fitness: ModelFitness): string {
	switch (fitness) {
		case "recommended":
			return "[recommended]";
		case "compatible":
			return "[compatible]";
		case "warning":
			return "[may be slow]";
		case "incompatible":
			return "[too large]";
	}
}

/** Fitness badge with theme colors */
function fitnessThemeBadge(fitness: ModelFitness, theme: any): string {
	switch (fitness) {
		case "recommended":
			return theme.fg("success", "[recommended]");
		case "compatible":
			return theme.fg("accent", "[compatible]");
		case "warning":
			return theme.fg("warning", "[may be slow]");
		case "incompatible":
			return theme.fg("error", "[too large]");
	}
}

export async function runVoiceOnboarding(
	ctx: VoiceUiContext,
	currentConfig: VoiceConfig,
	options?: { isFirstRun?: boolean }
): Promise<OnboardingResult | undefined> {
	const isFirstRun = options?.isFirstRun ?? !currentConfig.onboarding.completed;

	// ─── Smart local setup ────────────────────────────────
	const device = detectDevice();
	const detectedLang = localeToLanguageCode(device.systemLocale);
	const language = currentConfig.language || detectedLang;

	// Auto-recommend the best model
	const recommended = autoRecommendModel(LOCAL_MODELS, device, language);
	const deviceSummary = formatDeviceSummary(device);

	let localModel = currentConfig.localModel;

	if (recommended) {
		const fitness = getModelFitness(recommended, device);
		const setupChoice = await ctx.ui.select(`Detected: ${deviceSummary}`, [
			`Install ${recommended.name} (${recommended.size}) ${fitnessLabel(fitness)} — recommended`,
			"Choose a different model",
		]);
		if (!setupChoice) return undefined;

		if (setupChoice.startsWith("Install")) {
			// Accept recommendation — will auto-download on first use
			localModel = recommended.id;
			ctx.ui.notify(
				[
					`Selected: ${recommended.name} (${recommended.size})`,
					"Model downloads on first use — fully offline after that.",
					"",
					"Note: Local models transcribe after you finish recording (batch mode).",
				].join("\n"),
				"info"
			);
		} else if (setupChoice.startsWith("Choose")) {
			// Full model list with fuzzy search
			const picked = await pickLocalModel(ctx, localModel, language);
			if (!picked) return undefined;
			localModel = picked.id;
			ctx.ui.notify(`Selected: ${picked.name} (${picked.size})`, "info");
		}
	} else {
		// No recommendation — show full picker
		const picked = await pickLocalModel(ctx, localModel, language);
		if (!picked) return undefined;
		localModel = picked.id;
	}

	// ─── Choose language (first-run only) ────────────────────
	let langCode = currentConfig.language;
	if (isFirstRun) {
		// The model step above always settles an id; unknown ids resolve to the full list in local.ts.
		const { languages, englishOnly } = getLanguagesForLocalModel(localModel ?? "");
		if (englishOnly) {
			// Single-language model — auto-set
			langCode = languages[0]?.code || "en";
			const langName = languages[0]?.name || "English";
			ctx.ui.notify(`Language set to ${langName} (only language supported by this model).`, "info");
		} else {
			// Auto-detect from system locale, let user confirm or change
			const detectedEntry = languages.find((l) => l.code === detectedLang);
			if (detectedEntry) {
				langCode = detectedLang;
				ctx.ui.notify(
					`Language auto-detected: ${detectedEntry.name} (${detectedEntry.code}). Change in /voice-settings.`,
					"info"
				);
			} else {
				const picked = await pickLanguage(ctx, currentConfig.language, languages);
				if (!picked) return undefined;
				langCode = picked;
			}
		}
	}

	// ─── Choose scope ────────────────────────────────────────
	const scopeChoice = await ctx.ui.select("Where should pi-voicekit settings be saved?", [
		"Global (all projects)",
		"Project only (this repo)",
	]);
	if (!scopeChoice) return undefined;
	const selectedScope: VoiceSettingsScope = scopeChoice.startsWith("Project") ? "project" : "global";

	const selectedModel = LOCAL_MODELS.find((m) => m.id === localModel);

	const summaryLines = [
		`Backend: Local — ${selectedModel?.name || localModel} (in-process)`,
		`Language: ${languageDisplayName(langCode)}${isFirstRun ? "" : " (change in /voice-settings)"}`,
		`Scope: ${selectedScope}`,
	];

	const confirm = await ctx.ui.confirm("Confirm voice setup", summaryLines.join("\n"));
	if (!confirm) return undefined;

	return {
		selectedScope,
		summaryLines,
		config: {
			...currentConfig,
			language: langCode,
			scope: selectedScope,
			localModel,
			onboarding: {
				...currentConfig.onboarding,
				completed: false,
				schemaVersion: currentConfig.version,
				source: "first-run",
			},
		},
	};
}
