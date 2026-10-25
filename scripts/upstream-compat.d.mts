/**
 * Type surface of the upstream compatibility probe (`upstream-compat.mjs`).
 *
 * `scripts/` is outside `tsconfig.json`, which covers `extensions/` only, so this declaration is
 * what lets the test suite import the `.mjs` module under `tsconfig.tests.json`. It mirrors the
 * runtime exports; the `.d.mts` suffix is how TypeScript pairs a declaration with a `.mjs` file.
 */

/** Probe the latest upstream release unless a version is given. */
export const DEFAULT_TARGET: string;

/** Host-provided packages the probe pins to the target release. */
export const HOST_PACKAGES: readonly string[];

/** Thrown for malformed invocations; `main` maps it to exit code 2. */
export class UsageError extends Error {}

/** Parsed command line: a target plus the output switches. */
export interface ProbeArgs {
	target: string;
	keep: boolean;
	json: boolean;
	help: boolean;
}

/** A package manifest, as far as the probe touches it. */
export interface ProbeManifest {
	devDependencies: Record<string, string>;
	peerDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	scripts?: Record<string, string>;
	overrides?: Record<string, string>;
}

/** One spawned command's outcome. */
export interface ProbeCommandResult {
	status: number | null;
	failed: boolean;
	missing: boolean;
	output: string;
	/** The typecheck was not attempted because the install failed. */
	skipped?: boolean;
}

/** What the throwaway-tree probe observed. */
export interface ProbeResult {
	target: string;
	spec: string;
	keep: boolean;
	resolved: Record<string, string>;
	install: ProbeCommandResult;
	typecheck: ProbeCommandResult;
	passed: boolean;
	workdir: string | null;
}

export function parseArgs(argv: string[]): ProbeArgs;

/** `latest` or a full `x.y.z` (optionally `v`-prefixed), normalised to the manifest spelling. */
export function resolveTargetSpec(target: string): string;

/** Copy of `manifest` with both host packages pinned to `spec` and `overrides` dropped. */
export function applyTargetVersions(manifest: ProbeManifest, spec: string): ProbeManifest;

/** Build the throwaway tree, install the target release and typecheck `extensions/`. */
export function probe(options?: { target?: string; keep?: boolean }): ProbeResult;

/** CLI entry point; returns the process exit code. */
export function main(argv: string[]): number;
