/**
 * Type surface of the release contract checker (`release-check.mjs`).
 *
 * `scripts/` is outside `tsconfig.json`, which covers `extensions/` only, so this declaration is
 * what lets the test suite import the `.mjs` module under `tsconfig.tests.json`. It mirrors the
 * runtime exports; the `.d.mts` suffix is how TypeScript pairs a declaration with a `.mjs` file.
 */

/** The three files a release commit has to keep consistent, as their raw contents. */
export interface ReleaseFiles {
	packageJson: string;
	packageLock: string;
	changelog: string;
}

/**
 * Every violated release rule of spec §6.1 in `files`, one message each; an empty array means the
 * contract holds. `version` is compared verbatim — callers normalise `v1.2.3` themselves.
 */
export function checkRelease(files: ReleaseFiles, version: string): string[];
