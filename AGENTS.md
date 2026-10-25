# pi-voicekit — Contributing & Agent Guidelines

pi-voicekit is a **public, GitHub-hosted open-source project** (an independent
continuation of the now-dormant `codexstar69/pi-listen`, MIT). All repository-facing
text is **English-first**.

## Language policy (REQUIRED)

- **Commit messages**: always English, [Conventional Commits](https://www.conventionalcommits.org/)
  (`type(scope): summary`), e.g. `feat: …`, `fix: …`, `ci: …`, `docs: …`, `chore: …`.
- **Code comments & docstrings**: always English (`//`, `/* */`, `/** */`).
- **User-facing UI strings** (e.g. model `notes`, native language names) keep
  their localized renderings — they are product copy, not comments.
- **Docs & README**: English.

This file is the rule of record for agents and humans — there is deliberately no
`CLAUDE.md` companion; the machine-readable formatting baseline lives in
`.prettierrc.json` + `.editorconfig`.

## Development

- Toolchain: **Bun** 1.3.x. Gate: `bun run check` (= `bun run typecheck` + `bun test`);
  `bun run typecheck` compiles two projects — `tsconfig.json` for the extensions, and
  `tsconfig.tests.json` for the tests plus extensions, the only one that adds `bun-types`
  (pinned to the Bun version CI uses). CI also runs `bun run format:check`.
- Formatting SSOT: tabs, double quotes, `printWidth: 120`, `trailingComma: "es5"`
  (`.prettierrc.json`, prettier 3.3.3). Run `bun run format` on files you touched;
  CI runs `bun run format:check` over `**/*.{ts,mts,json,yml,yaml}` (code + config).
  Markdown is intentionally not gated — hand-format docs.
- Packaging: a change that ships files must be verified through `bun run smoke:installed` —
  it packs the tarball and starts both worker entries from a staged `node_modules` copy under
  plain `node`, because a package that only works in the repository is the failure this gate
  exists for. CI runs it in the `packaging` job on every pull request and every push to
  `main`.
- History hygiene: one commit = one logical change; keep diffs minimal and
  unrelated edits out.
- Worker entries: every module reachable from a worker entry must use explicit `.ts` value imports and
  erasable-only TypeScript, because a worker loads through the runtime resolver, not a bundler.
  `tests/worker-import-graph.test.ts` gates the import half.

## Releases

- **Tag-driven, never local.** Pushing a `vX.Y.Z` tag _is_ the release: CI publishes
  to npm (Trusted Publishing + provenance) and opens the GitHub Release. There is no
  local publish path — never run `bun publish` / `npm publish` by hand.
- **One source for release notes:** the `CHANGELOG.md` section for that version.
  A missing section fails the release, by design.
- **The release contract is checked, not trusted.** `bun run release:check` enforces the
  four CONTRIBUTING rules at once — `package.json` version, both `package-lock.json`
  version fields, a dated `## [x.y.z]` section with an emptied `[Unreleased]` above it, and
  the compare-link definitions. `release.yml` runs the same checker before Setup Bun, so a
  violated rule fails the release before anything is published.
- **One release commit:** `chore: release X.Y.Z` bumps `package.json` **and** moves
  `[Unreleased]` into `## [x.y.z] - <date>`, in the commit that gets tagged.

## Project context

- Fork of `codexstar69/pi-listen` (dormant upstream; last release v7.2.2, May 2026).
  Not affiliated with the original author — see README for the disclosure.
- Local improvements are the long-term mainline; intentional modification of
  upstream files is allowed when documented and covered by tests.
- Keep upstream attribution intact (MIT LICENSE, original author credit).
- Separate concern: our local forks may be adapted for private deployments —
  check `AGENTS-FORK.md` if present in a downstream repo.
