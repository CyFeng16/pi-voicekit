import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function getAgentDir(): string {
	return path.join(os.homedir(), ".pi", "agent");
}

export const SETTINGS_KEY = "voice";
// v4 removed the LLM polish pass and its five `postProcess*` fields; v5 removed the six fields that
// only the retired cloud backends used. Their values are ignored and never migrated, but an ordinary
// save keeps a file's own keys in place (spec §4.1); the version is bumped so the schema change is
// visible, and onboarding stays complete across the bump.
export const VOICE_CONFIG_VERSION = 5;

export type VoiceSettingsScope = "global" | "project";
export type VoiceConfigSource = VoiceSettingsScope | "default";

export interface VoiceOnboardingState {
	completed: boolean;
	schemaVersion: number;
	completedAt?: string;
	lastValidatedAt?: string;
	source?: "first-run" | "setup-command" | "migration" | "repair";
	skippedAt?: string;
}

export interface VoiceConfig {
	version: number;
	enabled: boolean;
	language: string;
	scope: VoiceSettingsScope;
	onboarding: VoiceOnboardingState;
	/** Local model ID (e.g. "whisper-small", "whisper-turbo", "parakeet-v3") */
	localModel?: string;
	/**
	 * Master switch for the offline punctuation step (spec §4.3). Scope-agnostic:
	 * a project file may set it, and `resolveSwitch` makes a machine-wide `false`
	 * final — no project block can re-enable it. Otherwise an explicit project
	 * value wins, and an omitted one inherits the global value.
	 */
	punctuationEnabled?: boolean;
	/**
	 * Master switch for the filler-particle cleanup (spec §4.4). Resolved by
	 * `resolveSwitch` exactly like `punctuationEnabled`: a global `false` is final,
	 * an explicit project value wins otherwise, and the default is on.
	 */
	fillerRemovalEnabled?: boolean;
	/**
	 * Master switch for the identifier-numeral cleanup (spec §4.4). Resolved by
	 * `resolveSwitch` exactly like `punctuationEnabled`: a global `false` is final,
	 * an explicit project value wins otherwise, and the default is on.
	 */
	numeralNormalizationEnabled?: boolean;
	/**
	 * Set once the one-time post-upgrade notice about the removed LLM polish pass has
	 * been shown (spec §4.6). Global-only — it describes this machine, not the
	 * repository, and it is written field by field so a project block cannot carry it.
	 */
	punctuationNoticeShown?: boolean;
	/** Global-only shortcut used to toggle recording without hold-to-talk */
	toggleShortcut?: string;

	// ─── TTS (text-to-speech) ─────────────────────────────────────────
	// All TTS fields are opt-in (default: TTS disabled). New in v6.0.0.

	/** Master TTS toggle. When false, /voice-speak is a no-op. */
	ttsEnabled?: boolean;
	/** Active local TTS model id (e.g. "kitten-nano-en-v0_2"). */
	ttsLocalModel?: string;
	/**
	 * Local backend speaker id (numeric `sid` per the model's voice
	 * catalog). Type-validated at config load — strings get rejected and
	 * fall back to the model's defaultSid.
	 */
	ttsLocalVoiceId?: number;
	/** Speech rate multiplier; range 0.5–2.0. Default 1.0. */
	ttsSpeed?: number;
	/**
	 * If true, the agent's responses are spoken automatically after each
	 * turn. v7.1.1: defaults to true so users get audio responses out of
	 * the box once TTS is enabled — disable via /voice-settings or
	 * `voice.ttsAutoSpeak = false` in settings.json.
	 */
	ttsAutoSpeak?: boolean;
	/**
	 * v7.1.1: If true, an STT transcription is automatically submitted to
	 * the agent (turn triggered) instead of just being placed in the
	 * editor. The user-spoken text bypasses the manual `[enter]` step.
	 * Defaults to false — preserves the v7.0.x behavior so existing
	 * users aren't surprised.
	 */
	autoSubmitOnSpeak?: boolean;
	/**
	 * v7.1.3: hold-to-talk activation delay in milliseconds. Range
	 * [200, 3000]. Default 700ms — snappy without being trigger-happy.
	 * Override via `/voice-hold-delay <ms>` or settings.json.
	 */
	holdThresholdMs?: number;
	/**
	 * BCP-47 language tag for TTS (overrides `language`). Useful when
	 * STT and TTS should use different languages — e.g. user dictates in
	 * English but wants Spanish read-back.
	 */
	ttsLanguage?: string;
	/**
	 * Set to true after `tts-onboarding.maybeShowTtsOnboarding()` has
	 * shown its first-run hint, so subsequent /voice-speak-toggle calls
	 * don't re-spam the same notification. New in v7.0.0.
	 */
	ttsOnboardingShown?: boolean;
}

export interface LoadedVoiceConfig {
	config: VoiceConfig;
	source: VoiceConfigSource;
	globalSettingsPath: string;
	projectSettingsPath: string;
}

export interface ConfigPathOptions {
	agentDir?: string;
	/**
	 * Where the in-memory config came from, when the caller knows. `"default"` means no settings
	 * file carried a `voice` block, so the object holds defaults — writing those over a file that
	 * DOES carry a block replaces the user's configuration with defaults (measured 2026-09-28:
	 * `backend`, `localModel` and `onboarding.completed` were wiped that way, which silently
	 * stopped hold-to-talk from being wired on the next start). `saveConfig` refuses that write.
	 */
	loadedSource?: VoiceSettingsScope | "default";
}

/** Default of the punctuation switch (spec §4.5) — on unless the user turns it off. */
const PUNCTUATION_ENABLED_DEFAULT = true;
/** Defaults of the two transcript-cleanup switches (spec §4.4) — on unless the machine turns them off. */
const CLEANUP_ENABLED_DEFAULT = true;

export const DEFAULT_CONFIG: VoiceConfig = {
	version: VOICE_CONFIG_VERSION,
	enabled: true,
	language: "en",
	scope: "global",
	localModel: undefined,
	punctuationEnabled: PUNCTUATION_ENABLED_DEFAULT,
	fillerRemovalEnabled: CLEANUP_ENABLED_DEFAULT,
	numeralNormalizationEnabled: CLEANUP_ENABLED_DEFAULT,
	punctuationNoticeShown: false,
	toggleShortcut: "ctrl+shift+v",
	// TTS defaults — all opt-in
	ttsEnabled: false,
	ttsLocalModel: "kitten-nano-en-v0_2",
	ttsLocalVoiceId: 0,
	ttsSpeed: 1.0,
	ttsAutoSpeak: true,
	autoSubmitOnSpeak: false,
	holdThresholdMs: 700,
	ttsLanguage: undefined,
	ttsOnboardingShown: false,
	onboarding: {
		completed: false,
		schemaVersion: VOICE_CONFIG_VERSION,
	},
};

export function readJsonFile(filePath: string): Record<string, unknown> {
	try {
		if (!fs.existsSync(filePath)) return {};
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch (err) {
		process.stderr.write(
			`[pi-voicekit] Warning: failed to read ${filePath}: ${err instanceof Error ? err.message : err}\n`
		);
		return {};
	}
}

export function getGlobalSettingsPath(options: ConfigPathOptions = {}): string {
	return path.join(options.agentDir ?? getAgentDir(), "settings.json");
}

export function getProjectSettingsPath(cwd: string): string {
	return path.join(cwd, ".pi", "settings.json");
}

function normalizeOnboarding(input: any, fallbackCompleted: boolean): VoiceOnboardingState {
	const completed = typeof input?.completed === "boolean" ? input.completed : fallbackCompleted;
	return {
		completed,
		schemaVersion: Number.isFinite(input?.schemaVersion) ? Number(input.schemaVersion) : VOICE_CONFIG_VERSION,
		completedAt: typeof input?.completedAt === "string" ? input.completedAt : undefined,
		lastValidatedAt: typeof input?.lastValidatedAt === "string" ? input.lastValidatedAt : undefined,
		source: typeof input?.source === "string" ? input.source : fallbackCompleted ? "migration" : undefined,
		skippedAt: typeof input?.skippedAt === "string" ? input.skippedAt : undefined,
	};
}

/**
 * Resolve one of the three switch fields (spec §4.4). A machine-wide `false` is
 * final and no project block can re-enable it; otherwise an explicit project value
 * wins, then the global value, then the default. A corrupt or unreadable global
 * settings file reads as `{}` (`readJsonFile`), so its value is absent here and the
 * project value wins — a known limit of this helper, not a missing branch.
 */
function resolveSwitch(projectValue: unknown, globalValue: unknown, fallback: boolean): boolean {
	if (globalValue === false) return false;
	if (typeof projectValue === "boolean") return projectValue;
	if (typeof globalValue === "boolean") return globalValue;
	return fallback;
}

function migrateConfig(rawVoice: any, source: VoiceConfigSource, globalVoice?: unknown): VoiceConfig {
	if (!rawVoice || typeof rawVoice !== "object") {
		return structuredClone(DEFAULT_CONFIG);
	}

	// Global-only fields resolve from the global block in BOTH scopes (spec §4.2), so a cloned
	// project file cannot set them.
	const globalRaw: Record<string, unknown> =
		globalVoice && typeof globalVoice === "object" ? (globalVoice as Record<string, unknown>) : {};
	const globalOnly = (key: string): unknown => (source === "project" ? globalRaw[key] : rawVoice[key]);
	const asBoolean = (value: unknown, fallbackValue: boolean): boolean =>
		typeof value === "boolean" ? value : fallbackValue;

	// Legacy files may carry the raw `backend`+`model` keys — they are not typed fields any more,
	// but treating the pair as a completed setup keeps their owners out of the setup wizard.
	const hasMeaningfulLegacySetup =
		(typeof rawVoice.backend === "string" && typeof rawVoice.model === "string") ||
		rawVoice.onboarding?.completed === true;
	const fallbackCompleted = hasMeaningfulLegacySetup;

	return {
		version: VOICE_CONFIG_VERSION,
		enabled: typeof rawVoice.enabled === "boolean" ? rawVoice.enabled : DEFAULT_CONFIG.enabled,
		language: typeof rawVoice.language === "string" ? rawVoice.language : DEFAULT_CONFIG.language,
		scope: (rawVoice.scope as VoiceSettingsScope | undefined) ?? (source === "project" ? "project" : "global"),
		// The three switch fields share one resolution (spec §4.4): a global false is
		// final, so it survives (and beats) a project block; otherwise the project value
		// wins, then the global one, then the default.
		punctuationEnabled: resolveSwitch(
			rawVoice.punctuationEnabled,
			globalRaw.punctuationEnabled,
			PUNCTUATION_ENABLED_DEFAULT
		),
		fillerRemovalEnabled: resolveSwitch(
			rawVoice.fillerRemovalEnabled,
			globalRaw.fillerRemovalEnabled,
			CLEANUP_ENABLED_DEFAULT
		),
		numeralNormalizationEnabled: resolveSwitch(
			rawVoice.numeralNormalizationEnabled,
			globalRaw.numeralNormalizationEnabled,
			CLEANUP_ENABLED_DEFAULT
		),
		// Global-only: it describes this machine, not the repository, so a cloned
		// project file cannot silence the one-time upgrade notice.
		punctuationNoticeShown: asBoolean(globalOnly("punctuationNoticeShown"), false),
		localModel: typeof rawVoice.localModel === "string" ? rawVoice.localModel : undefined,
		toggleShortcut:
			source !== "project" && typeof rawVoice.toggleShortcut === "string"
				? rawVoice.toggleShortcut
				: DEFAULT_CONFIG.toggleShortcut,
		// TTS fields — type-validated; mismatched persisted values fall
		// back to safe defaults so a hand-edited config can't poison the
		// engine. Notably: ttsLocalVoiceId rejects strings, which would
		// crash sherpa's numeric sid argument.
		ttsEnabled: typeof rawVoice.ttsEnabled === "boolean" ? rawVoice.ttsEnabled : DEFAULT_CONFIG.ttsEnabled,
		ttsLocalModel:
			typeof rawVoice.ttsLocalModel === "string" && rawVoice.ttsLocalModel
				? rawVoice.ttsLocalModel
				: DEFAULT_CONFIG.ttsLocalModel,
		ttsLocalVoiceId:
			typeof rawVoice.ttsLocalVoiceId === "number" && Number.isFinite(rawVoice.ttsLocalVoiceId)
				? rawVoice.ttsLocalVoiceId
				: DEFAULT_CONFIG.ttsLocalVoiceId,
		ttsSpeed:
			typeof rawVoice.ttsSpeed === "number" && Number.isFinite(rawVoice.ttsSpeed)
				? Math.max(0.5, Math.min(2.0, rawVoice.ttsSpeed))
				: DEFAULT_CONFIG.ttsSpeed,
		ttsAutoSpeak: typeof rawVoice.ttsAutoSpeak === "boolean" ? rawVoice.ttsAutoSpeak : DEFAULT_CONFIG.ttsAutoSpeak,
		autoSubmitOnSpeak:
			typeof rawVoice.autoSubmitOnSpeak === "boolean" ? rawVoice.autoSubmitOnSpeak : DEFAULT_CONFIG.autoSubmitOnSpeak,
		holdThresholdMs:
			typeof rawVoice.holdThresholdMs === "number" &&
			Number.isFinite(rawVoice.holdThresholdMs) &&
			rawVoice.holdThresholdMs >= 200 &&
			rawVoice.holdThresholdMs <= 3000
				? rawVoice.holdThresholdMs
				: DEFAULT_CONFIG.holdThresholdMs,
		ttsLanguage: typeof rawVoice.ttsLanguage === "string" && rawVoice.ttsLanguage ? rawVoice.ttsLanguage : undefined,
		ttsOnboardingShown: typeof rawVoice.ttsOnboardingShown === "boolean" ? rawVoice.ttsOnboardingShown : false,
		onboarding: normalizeOnboarding(rawVoice.onboarding, fallbackCompleted),
	};
}

export function loadConfigWithSource(cwd: string, options: ConfigPathOptions = {}): LoadedVoiceConfig {
	const globalSettingsPath = getGlobalSettingsPath(options);
	const projectSettingsPath = getProjectSettingsPath(cwd);
	const globalVoice = readJsonFile(globalSettingsPath)[SETTINGS_KEY];
	const projectVoice = readJsonFile(projectSettingsPath)[SETTINGS_KEY];

	if (projectVoice && typeof projectVoice === "object") {
		return {
			config: migrateConfig(projectVoice, "project", globalVoice),
			source: "project",
			globalSettingsPath,
			projectSettingsPath,
		};
	}

	if (globalVoice && typeof globalVoice === "object") {
		return {
			config: migrateConfig(globalVoice, "global"),
			source: "global",
			globalSettingsPath,
			projectSettingsPath,
		};
	}

	return {
		config: structuredClone(DEFAULT_CONFIG),
		source: "default",
		globalSettingsPath,
		projectSettingsPath,
	};
}

const VALID_MODIFIERS = new Set(["ctrl", "shift", "alt", "meta", "cmd", "super"]);
const SHORTCUT_PATTERN = /^[a-z0-9+]+$/;

/** Validate a shortcut string like "ctrl+shift+v". Returns true if structurally valid. */
export function isValidShortcut(shortcut: string): boolean {
	if (typeof shortcut !== "string" || shortcut.length === 0 || !SHORTCUT_PATTERN.test(shortcut)) return false;
	const parts = shortcut.split("+");
	if (parts.length < 1 || parts.length > 4) return false;
	const key = parts[parts.length - 1]!;
	if (key.length === 0) return false;
	const mods = parts.slice(0, -1);
	return mods.every((m) => VALID_MODIFIERS.has(m));
}

/**
 * Resolve the toggle shortcut from global config at startup.
 * Returns the validated shortcut or the default if invalid/missing.
 * Reads disk once — caller should cache the result.
 */
export function loadGlobalToggleShortcut(options: ConfigPathOptions = {}): string {
	const fallback = DEFAULT_CONFIG.toggleShortcut || "ctrl+shift+v";
	try {
		const globalSettingsPath = getGlobalSettingsPath(options);
		const globalVoice = readJsonFile(globalSettingsPath)[SETTINGS_KEY];
		if (globalVoice && typeof globalVoice === "object" && typeof (globalVoice as any).toggleShortcut === "string") {
			const candidate = (globalVoice as any).toggleShortcut;
			if (isValidShortcut(candidate)) return candidate;
			process.stderr.write(
				`[pi-voicekit] Warning: invalid toggleShortcut "${candidate}" in settings, using default "${fallback}"\n`
			);
		}
	} catch {
		// Fall through to default
	}
	return fallback;
}

function serializeConfig(config: VoiceConfig, scope: VoiceSettingsScope): VoiceConfig {
	return {
		...config,
		scope,
		// The punctuation notice flag describes this machine, not this repository.
		punctuationNoticeShown: scope === "project" ? undefined : config.punctuationNoticeShown,
		// Shortcut registration is static at extension load time — project-scoped overrides cannot apply
		toggleShortcut: scope === "project" ? undefined : config.toggleShortcut,
		onboarding: {
			...config.onboarding,
			schemaVersion: VOICE_CONFIG_VERSION,
		},
	};
}

/**
 * The five settings removed with the LLM polish pass. v4 ignores them, but an ordinary
 * save must not delete them (spec §4.1, decision 10): the maintainer's ruling is
 * "ignored, never deleted" and no write-side migration happens, so a user who rolls
 * back to an older release still finds their original switch state. They are copied
 * through as raw values and never read into the runtime config.
 */
const LEGACY_POST_PROCESS_KEYS = [
	"postProcessEnabled",
	"postProcessModel",
	"postProcessContextTurns",
	"postProcessTimeoutMs",
	"postProcessNoticeShown",
] as const;

/**
 * Atomic settings write: a private staging directory, a file created exclusively inside it, and a
 * rename over the settings file so a partial write can never be observed. Shared by every writer in
 * this module so the path cannot diverge — which is also why the permissions are handled here and
 * nowhere else.
 *
 * The staging path is `mkdtempSync`'s, never a predictable `${pid}.tmp` name: that name is guessed
 * (and left behind by a crash) and a plain write reuses whatever is already there, keeping ITS mode —
 * so a planted or leftover world-readable file would receive this document, which holds every other
 * plugin's credentials, before anything tightened it. A fresh 0700 directory is not reachable by other
 * users at all, the `wx` open never reuses a path, and the mode the file must keep is applied through
 * the open handle while the text is still unreachable. A missing settings file gets 0600 rather than
 * the umask default (0644 on a common 022 umask).
 *
 * The text form exists for the scrub, which edits a settings file by deleting a member's bytes instead
 * of reserializing the whole document (`JSON.parse` → `JSON.stringify` silently rounds integers beyond
 * 2^53 and writes `1e400` back as `null`).
 */
function writeSettingsText(settingsPath: string, text: string): void {
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
	const mode = settingsFileMode(settingsPath);
	const stagingDir = fs.mkdtempSync(`${settingsPath}.tmp-`);
	const stagingPath = path.join(stagingDir, path.basename(settingsPath));
	let fd: number | null = null;
	try {
		// 0600 for the first byte (the umask can only narrow it), then `fchmod` to the exact mode the
		// settings file keeps — widening is only safe once the file is out of reach of other users.
		fd = fs.openSync(stagingPath, "wx", 0o600);
		fs.writeFileSync(fd, text);
		fs.fchmodSync(fd, mode);
		fs.closeSync(fd);
		fd = null;
		fs.renameSync(stagingPath, settingsPath);
	} finally {
		if (fd !== null) {
			try {
				fs.closeSync(fd);
			} catch {}
		}
		try {
			fs.rmSync(stagingDir, { recursive: true, force: true });
		} catch {}
	}
}

/** The mode a settings write must land on: the existing file's own, or 0600 for a new file. */
function settingsFileMode(settingsPath: string): number {
	try {
		return fs.statSync(settingsPath).mode & 0o777;
	} catch {
		return 0o600;
	}
}

function writeSettingsFile(settingsPath: string, settings: Record<string, unknown>): void {
	writeSettingsText(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

/**
 * Write the `voice` block into a settings file, leaving every other top-level member exactly as it
 * was on disk. A missing file is written fresh; a file without a `voice` member gets one added; a
 * file whose shape the scanner refuses throws before anything is written. Every writer in this module
 * ends in `writeSettingsText`, which owns the atomic write and the permissions; the two that serialize
 * a `voice` block end here, so neither can reserialize a member it does not own.
 */
function writeVoiceBlock(
	settingsPath: string,
	read: { text: string; settings: Record<string, unknown> },
	voice: Record<string, unknown>
): void {
	// A missing file is the only shape `readSettingsForWrite` reports as empty text. A file that exists
	// but cannot be parsed has already thrown there.
	if (read.text === "") {
		writeSettingsFile(settingsPath, { [SETTINGS_KEY]: voice });
		return;
	}
	writeSettingsText(settingsPath, spliceVoiceMember(read.text, read.settings, voice));
}

/**
 * Read a settings file for a write, as both text and parsed value. A missing file is empty text and
 * `{}`; a file that exists but cannot be parsed must NOT be treated as missing — merging into `{}`
 * would replace a damaged settings file with a fresh object and lose every other key. It is logged
 * and left untouched instead, and the throw hands the failure to the caller's guard rather than
 * reporting a write that never happened. The raw text is returned for writers that must not
 * reserialize values they do not change.
 */
function readSettingsForWrite(settingsPath: string): { text: string; settings: Record<string, unknown> } {
	if (!fs.existsSync(settingsPath)) return { text: "", settings: {} };
	try {
		const text = fs.readFileSync(settingsPath, "utf8");
		return { text, settings: JSON.parse(text) as Record<string, unknown> };
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[pi-voicekit] Warning: not writing ${settingsPath}: ${reason}\n`);
		throw new Error(`Refusing to overwrite an unreadable settings file: ${settingsPath}`);
	}
}

export function saveConfig(
	config: VoiceConfig,
	scope: VoiceSettingsScope,
	cwd: string,
	options: ConfigPathOptions = {}
): string {
	const settingsPath = scope === "project" ? getProjectSettingsPath(cwd) : getGlobalSettingsPath(options);
	const read = readSettingsForWrite(settingsPath);
	const settings = read.settings;
	const serialized: Record<string, unknown> = { ...serializeConfig(config, scope) };
	const existingVoice = settings[SETTINGS_KEY];
	// A config loaded from nowhere (no settings file carried a `voice` block) holds defaults, so
	// writing it over a block that exists replaces the user's configuration with defaults.
	// A file without a `voice` block is a first save and still goes through.
	if (options.loadedSource === "default" && existingVoice && typeof existingVoice === "object") {
		process.stderr.write(`[pi-voicekit] Warning: not writing ${settingsPath}: the config came from defaults\n`);
		throw new Error(`Refusing to overwrite the existing voice settings in ${settingsPath} with defaults`);
	}
	// Carry the legacy keys of THIS file's block through, raw values only: the loader ignores
	// them (they never enter `config`), and a save into the other scope's file must neither
	// copy them nor drop them from a user who rolls back to an older release.
	if (existingVoice && typeof existingVoice === "object") {
		for (const key of LEGACY_POST_PROCESS_KEYS) {
			const value = (existingVoice as Record<string, unknown>)[key];
			if (value !== undefined) serialized[key] = value;
		}
	}
	// Only the `voice` member is rewritten: every other top-level member of the file keeps its raw
	// bytes, so a value another plugin stored that JavaScript cannot round-trip survives this write.
	writeVoiceBlock(settingsPath, read, serialized);
	return settingsPath;
}

/**
 * The global-only keys `saveGlobalVoiceFields` accepts. A project block cannot
 * carry them — `serializeConfig` strips them and the loader ignores them — so
 * they always belong in the global file.
 */
type GlobalVoiceFieldKey = "punctuationNoticeShown";

/**
 * Field-level writer for the global-only voice settings (R26).
 *
 * `saveConfig(config, "global", …)` renders the WHOLE in-memory config, and in a
 * project-scoped session that object also carries project and default values —
 * writing it globally silently resets every unrelated machine-global setting
 * (TTS speed, auto-submit, hold threshold, …). This writer instead reads the
 * existing global file and merges only the named keys into its `voice` block:
 *
 * - an existing `version` is preserved; a block created here gets the current
 *   schema version,
 * - no other key is created, changed or removed,
 * - a missing file or `voice` block is created,
 * - a file that exists but cannot be parsed is refused, not overwritten,
 * - the write is atomic (temp file + rename), like `saveConfig`.
 */
export function saveGlobalVoiceFields(
	fields: Partial<Pick<VoiceConfig, GlobalVoiceFieldKey>>,
	options: ConfigPathOptions = {}
): string {
	const settingsPath = getGlobalSettingsPath(options);
	// A file that exists but cannot be parsed is refused, not overwritten — see readSettingsForWrite.
	const read = readSettingsForWrite(settingsPath);
	const existing = read.settings[SETTINGS_KEY];
	const voice: Record<string, unknown> =
		existing && typeof existing === "object" ? { ...(existing as Record<string, unknown>) } : {};
	if (typeof voice.version !== "number") voice.version = VOICE_CONFIG_VERSION;
	for (const [key, value] of Object.entries(fields)) {
		if (value !== undefined) voice[key] = value;
	}
	writeVoiceBlock(settingsPath, read, voice);
	return settingsPath;
}

/**
 * The two settings a 0.5.x file may still carry from the retired speech backends. They are not read
 * any more, but they are still credentials on disk, and the product claims no audio is uploaded to a
 * remote speech service — so the first start after the upgrade erases them rather than leave them
 * lying there. They are spelled here, in the one file the egress gate exempts, so `voice.ts` never has
 * to name them.
 */
const RETIRED_VOICE_KEYS = ["deepgramApiKey", "localEndpoint"] as const;

/**
 * A member of a JSON object as it sits in the raw text: `start` is the opening quote of its key and
 * `end` the last byte of its value. `leadingStart` .. `end` covers the member together with its own
 * indentation, so members around a deleted one keep their exact layout; `valueStart` .. `end` is the
 * value alone.
 */
interface RawMember {
	key: string;
	leadingStart: number;
	start: number;
	valueStart: number;
	end: number;
}

const JSON_WHITESPACE = " \t\n\r";
const JSON_TOKEN_BREAK = ",:[]{}" + JSON_WHITESPACE;

function skipJsonWhitespace(text: string, index: number): number {
	let i = index;
	while (i < text.length && JSON_WHITESPACE.includes(text[i])) i += 1;
	return i;
}

/** `text[index]` is a quote: return the index just past the closing quote of that string. */
function scanJsonString(text: string, index: number): number {
	let i = index + 1;
	while (i < text.length) {
		const ch = text[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === '"') return i + 1;
		i += 1;
	}
	throw new Error(`unterminated string at offset ${index}`);
}

/** `text[index]` opens a `{` or `[`: return the index just past its matching close. */
function scanJsonContainer(text: string, index: number): number {
	const stack: string[] = [];
	let i = index;
	while (i < text.length) {
		const ch = text[i];
		if (ch === '"') {
			i = scanJsonString(text, i);
			continue;
		}
		if (ch === "{" || ch === "[") {
			stack.push(ch);
		} else if (ch === "}" || ch === "]") {
			const open = stack.pop();
			if (!((ch === "}" && open === "{") || (ch === "]" && open === "["))) {
				throw new Error(`unbalanced "${ch}" at offset ${i}`);
			}
			if (stack.length === 0) return i + 1;
		}
		i += 1;
	}
	throw new Error(`unterminated container at offset ${index}`);
}

function scanJsonValue(text: string, index: number): number {
	const ch = text[index];
	if (ch === '"') return scanJsonString(text, index);
	if (ch === "{" || ch === "[") return scanJsonContainer(text, index);
	let i = index;
	while (i < text.length && !JSON_TOKEN_BREAK.includes(text[i])) i += 1;
	if (i === index) throw new Error(`unexpected "${ch}" at offset ${index}`);
	return i;
}

/**
 * Locate every member of the JSON object opening at `openBrace`. Values are measured, never decoded:
 * that is what lets a writer delete one member and leave number literals the JavaScript number type
 * cannot hold (`9007199254740993`, `1e400`) exactly as they were. Throws on text it cannot read, so
 * a caller refuses to rewrite rather than guess at the shape.
 */
function scanJsonObjectMembers(text: string, openBrace: number): { closeBrace: number; members: RawMember[] } {
	if (text[openBrace] !== "{") throw new Error(`expected "{" at offset ${openBrace}`);
	const members: RawMember[] = [];
	let leadingStart = openBrace + 1;
	let i = skipJsonWhitespace(text, leadingStart);
	if (text[i] === "}") return { closeBrace: i, members };
	for (;;) {
		const keyStart = i;
		if (text[i] !== '"') throw new Error(`expected an object key at offset ${i}`);
		const keyEnd = scanJsonString(text, keyStart);
		const key = JSON.parse(text.slice(keyStart, keyEnd)) as string;
		i = skipJsonWhitespace(text, keyEnd);
		if (text[i] !== ":") throw new Error(`expected ":" at offset ${i}`);
		i = skipJsonWhitespace(text, i + 1);
		const valueStart = i;
		const valueEnd = scanJsonValue(text, i);
		members.push({ key, leadingStart, start: keyStart, valueStart, end: valueEnd });
		i = skipJsonWhitespace(text, valueEnd);
		if (text[i] === ",") {
			leadingStart = i + 1;
			i = skipJsonWhitespace(text, leadingStart);
			continue;
		}
		if (text[i] === "}") return { closeBrace: i, members };
		throw new Error(`expected "," or "}" at offset ${i}`);
	}
}

/**
 * Locate the top-level object of a settings document. Values are measured, never decoded: that is
 * what lets a writer replace one member and leave number literals the JavaScript number type cannot
 * hold (`9007199254740993`, `1e400`) exactly as they were. Throws on text it cannot read, so a caller
 * refuses to rewrite rather than guess at the shape.
 */
function scanTopLevelObject(text: string): { openBrace: number; closeBrace: number; members: RawMember[] } {
	const openBrace = skipJsonWhitespace(text, 0);
	return { openBrace, ...scanJsonObjectMembers(text, openBrace) };
}

/**
 * The top-level member named `key`. `required` separates the two callers: a delete needs exactly one
 * member to delete, an update inserts when it is absent. More than one is ambiguous in both cases —
 * the copies would have to be reconciled — so it throws instead of picking one.
 */
function findTopLevelMember(members: RawMember[], key: string, required: boolean): RawMember | undefined {
	const found = members.filter((member) => member.key === key);
	if (found.length > 1 || (required && found.length === 0)) {
		throw new Error(`expected ${required ? "exactly one" : "at most one"} "${key}" member, found ${found.length}`);
	}
	return found[0];
}

/**
 * Delete the named members from the top-level object `key` of `text` and return the rewritten text.
 * Only the deleted members' bytes disappear; every other member keeps its exact spelling (number
 * literals included) and its indentation. The result is re-parsed and compared against the parsed
 * settings minus the deleted keys, so a disagreement between the scan and the parser is a refusal,
 * not a damaged file.
 */
function removeObjectMembers(
	text: string,
	settings: Record<string, unknown>,
	key: string,
	keysToRemove: readonly string[]
): string {
	const top = scanTopLevelObject(text);
	const target = findTopLevelMember(top.members, key, true)!;

	const inner = scanJsonObjectMembers(text, target.valueStart);
	const kept = inner.members.filter((member) => !keysToRemove.includes(member.key));
	if (kept.length === inner.members.length) throw new Error(`"${key}" holds none of the members to remove`);

	const body = kept.map((member) => text.slice(member.leadingStart, member.end)).join(",");
	const tail = text.slice(inner.members[inner.members.length - 1].end, inner.closeBrace);
	const patched = text.slice(0, target.valueStart) + "{" + body + tail + "}" + text.slice(target.end);

	const remaining = { ...(settings[key] as Record<string, unknown>) };
	for (const removedKey of keysToRemove) delete remaining[removedKey];
	if (JSON.stringify(JSON.parse(patched)) !== JSON.stringify({ ...settings, [key]: remaining })) {
		throw new Error(`refusing to rewrite "${key}": the edited text does not match the parsed settings`);
	}
	return patched;
}

/** `text` with every newline indented by `unit`, so a serialized value sits at its own nesting depth. */
function indentSerialized(serialized: string, unit: string): string {
	return serialized.replace(/\n/g, `\n${unit}`);
}

/** The indentation a member's key sits at: its leading whitespace up to and including the last newline. */
function memberIndent(text: string, member: RawMember): string {
	return text.slice(member.leadingStart, member.start);
}

/** Only the column part of an indent string — what a continuation line inside the member needs. */
function indentUnit(indent: string): string {
	return indent.slice(indent.lastIndexOf("\n") + 1);
}

/**
 * Replace the top-level `voice` member of `text` with `voice`, or insert it, and return the rewritten
 * text. Every other top-level member is copied verbatim: its bytes are never decoded, so values a
 * JavaScript number cannot hold (`9007199254740993`, `1e400`) survive a write that does not own them.
 *
 * This is what keeps the scrub from being undone by the next save. The two writers that reserialized
 * the whole document — `saveGlobalVoiceFields` and `saveConfig`, both of which run on the same startup
 * as the scrub — corrupted every other plugin's numbers on the way, which is why they now share this
 * splice instead.
 *
 * Refuses (throws) on a shape it cannot read: a document that is not a single JSON object, a
 * duplicated `voice` member, or an edit whose re-parse disagrees with the value it wrote.
 */
function spliceVoiceMember(text: string, settings: Record<string, unknown>, voice: Record<string, unknown>): string {
	const top = scanTopLevelObject(text);
	const target = findTopLevelMember(top.members, SETTINGS_KEY, false);
	const value = JSON.stringify(voice, null, 2);
	// The whole member as it would be written at column zero; the insert branches re-indent it.
	const member = `${JSON.stringify(SETTINGS_KEY)}: ${value}`;
	let patched: string;
	if (target) {
		// In place: only the value is replaced — the key and the separator already holding it stay as
		// they were, and the member's own indentation is where its closing brace belongs.
		patched =
			text.slice(0, target.valueStart) +
			indentSerialized(value, indentUnit(memberIndent(text, target))) +
			text.slice(target.end);
	} else if (top.members.length === 0) {
		// `{}`: give it the layout the other writers produce.
		patched = `${text.slice(0, top.openBrace + 1)}\n  ${indentSerialized(member, "  ")}\n${text.slice(top.closeBrace)}`;
	} else {
		// Absent: add it after the last member, reusing that member's indentation and re-emitting the
		// whitespace that separated it from the closing brace.
		const first = top.members[0]!;
		const last = top.members[top.members.length - 1]!;
		const indent = memberIndent(text, first);
		const tail = text.slice(last.end, top.closeBrace);
		patched =
			text.slice(0, last.end) +
			"," +
			indent +
			indentSerialized(member, indentUnit(indent)) +
			tail +
			text.slice(top.closeBrace);
	}

	// A disagreement between the scan and the parser is a refusal, not a damaged file.
	if (JSON.stringify(JSON.parse(patched)) !== JSON.stringify({ ...settings, [SETTINGS_KEY]: voice })) {
		throw new Error(`refusing to rewrite "${SETTINGS_KEY}": the edited text does not match the intended settings`);
	}
	return patched;
}

/**
 * Erase the retired credentials from a settings file, in place.
 *
 * Best-effort by contract:
 * - a missing file returns `{ removed: [] }` and is NOT created — a machine that never configured
 *   voice should not grow a settings file out of a cleanup;
 * - a file that exists but cannot be parsed throws (`readSettingsForWrite`) instead of being
 *   replaced by `{}`; the caller decides what that failure costs;
 * - a file with nothing to remove is not rewritten at all.
 *
 * `message` is the finished, user-facing sentence, assembled here rather than at the call site:
 * `voice.ts` must never contain a retired identifier (spec §8.3), and this module is the single
 * exemption in `tests/no-cloud-egress.test.ts`. The sentence names the keys and the environment
 * variable, and never the secret value or an endpoint host.
 *
 * Deliberately not `saveConfig`: that refuses to write when the in-memory config came from defaults,
 * and it rebuilds the `voice` block from the parsed config. Here the file is the truth for the
 * `voice` block too, and the rewrite deletes the two members from the raw text instead of
 * reserializing the block — the same rule the two serializing writers follow for every top-level
 * member they do not own (`spliceVoiceMember`).
 */
export function scrubRetiredVoiceKeys(settingsPath: string): { removed: string[]; message?: string } {
	if (!fs.existsSync(settingsPath)) return { removed: [] };

	const { text, settings } = readSettingsForWrite(settingsPath);
	const existing = settings[SETTINGS_KEY];
	if (!existing || typeof existing !== "object" || Array.isArray(existing)) return { removed: [] };

	const removed = RETIRED_VOICE_KEYS.filter((key) => key in existing);
	if (removed.length === 0) return { removed: [] };

	writeSettingsText(settingsPath, removeObjectMembers(text, settings, SETTINGS_KEY, removed));

	return {
		removed,
		message: [
			"pi-voicekit is local-only from 0.6.0: no audio is uploaded to a remote speech service.",
			`Erased the retired ${removed.join(" and ")} from ${settingsPath}.`,
			"A DEEPGRAM_API_KEY exported from ~/.env.secrets or a shell rc file is no longer read,",
			"and pi-voicekit does not edit those files — delete it there yourself.",
			"That claim has two exceptions — system audio routing and /voice-autosubmit — documented",
			"in the Privacy section of README.md.",
		].join("\n"),
	};
}

export function needsOnboarding(config: VoiceConfig, source: VoiceConfigSource): boolean {
	const skippedAt = config.onboarding.skippedAt ? Date.parse(config.onboarding.skippedAt) : Number.NaN;
	const deferWindowMs = 1000 * 60 * 60 * 24;
	const recentlyDeferred = Number.isFinite(skippedAt) && Date.now() - skippedAt < deferWindowMs;
	if (recentlyDeferred) return false;
	if (source === "default") return true;
	return !config.onboarding.completed;
}
