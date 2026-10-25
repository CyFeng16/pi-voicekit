/**
 * Type surface of the repository-side CHANGELOG entry extractor (`changelog-entry.mjs`).
 *
 * `scripts/` is outside `tsconfig.json`, which covers `extensions/` only, so this declaration is
 * what lets the test suite import the `.mjs` module under `tsconfig.tests.json`. It mirrors the
 * runtime exports; the `.d.mts` suffix is how TypeScript pairs a declaration with a `.mjs` file.
 */

/** One `## [version]` section: `ok` carries its body, the other two carry nothing. */
export type ChangelogEntry = { status: "missing" } | { status: "empty" } | { status: "ok"; body: string };

/** `v1.2.3`, `[1.2.3]`, `Unreleased` and its bracketed spelling, collapsed to the bare version. */
export function normalizeVersion(input: string): string;

/** The `version` section of `markdown` without its heading, or why there is none. */
export function extractEntry(markdown: string, version: string): ChangelogEntry;
