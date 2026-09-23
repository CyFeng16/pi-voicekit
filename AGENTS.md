# pi-voicekit — Contributing & Agent Guidelines

pi-voicekit is a **public, GitHub-hosted open-source project** (an independent
continuation of the archived `codexstar69/pi-listen`, MIT). All repository-facing
text is **English-first**.

## Language policy (REQUIRED)

- **Commit messages**: always English, [Conventional Commits](https://www.conventionalcommits.org/)
  (`type(scope): summary`), e.g. `feat: …`, `fix: …`, `ci: …`, `docs: …`, `chore: …`.
- **Code comments & docstrings**: always English (`//`, `/* */`, `/** */`).
- **User-facing UI strings** (e.g. model `notes`, native language names) keep
  their localized renderings — they are product copy, not comments.
- **Docs & README**: English.

This file is the rule of record for agents and humans; the machine-readable
formatting baseline lives in `.prettierrc.json` + `.editorconfig`.

## Development

- Toolchain: **Bun** 1.3.x. Gate: `bun run check` (= `bunx tsc -p tsconfig.json` + `bun test`); CI also runs `bun run format:check`.
- Formatting SSOT: tabs, double quotes, `printWidth: 120`, `trailingComma: "es5"`
  (`.prettierrc.json`, prettier 3.3.3). Run `bun run format` on files you touched;
  CI runs `bun run format:check` over `**/*.{ts,json,yml,yaml}` (code + config).
  Markdown is intentionally not gated — hand-format docs.
- History hygiene: one commit = one logical change; keep diffs minimal and
  unrelated edits out.

## Project context

- Fork of `codexstar69/pi-listen` (archived upstream; last release v7.2.2).
  Not affiliated with the original author — see README for the disclosure.
- Local improvements are the long-term mainline; intentional modification of
  upstream files is allowed when documented and covered by tests.
- Keep upstream attribution intact (MIT LICENSE, original author credit).
- Separate concern: our local forks may be adapted for private deployments —
  check `AGENTS-FORK.md` if present in a downstream repo.
