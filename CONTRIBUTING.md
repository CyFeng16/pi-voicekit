# Contributing to pi-voicekit

Thank you for your interest in contributing to pi-voicekit! This document provides guidelines and information for contributors.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Making Changes](#making-changes)
- [Testing](#testing)
- [Pull Request Process](#pull-request-process)
- [Release](#release)
- [Upstream tracking](#upstream-tracking)
- [Coding Standards](#coding-standards)
- [Reporting Issues](#reporting-issues)

---

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## Getting Started

1. Fork the repository on GitHub
2. Clone your fork locally
3. Create a feature branch from `main`
4. Make your changes
5. Submit a pull request

## Development Setup

### Prerequisites

- **Bun** ≥ 1.0 (package manager and test runner)
- **SoX** (for microphone recording: `brew install sox`)

### Install Dependencies

```bash
git clone https://github.com/CyFeng16/pi-voicekit.git
cd pi-voicekit
bun install
```

### Verify Setup

```bash
bun run check    # typecheck + test
```

## Project Structure

```
pi-voicekit/
├── extensions/
│   ├── voice.ts              # Main extension — state machine, recording, UI
│   └── voice/
│       ├── config.ts          # Config loading, saving, migration, retired-key scrub
│       ├── onboarding.ts      # Model and language pickers, first-run flow
│       └── transcript-cleanup.ts # Filler particles, spoken numerals, cleanup switches
├── tests/                     # Test suites (Bun test runner)
├── docs/
│   └── troubleshooting.md     # Troubleshooting guide
├── package.json               # Package manifest
└── tsconfig.json              # TypeScript config
```

## Making Changes

### Branch Naming

- `feat/description` — New features
- `fix/description` — Bug fixes
- `docs/description` — Documentation only
- `refactor/description` — Code restructuring
- `test/description` — Test additions/changes

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add VAD pre-filtering for voice input
fix: prevent a stale install widget after a cancelled download
docs: document the model download sources
test: add config migration edge cases
refactor: extract the model directory resolution to config
```

## Testing

### Run All Tests

```bash
bun run test
```

### Run Specific Tests

```bash
bun run test -- -t "config"    # Tests matching "config"
bun test tests/config.test.ts  # Specific file
```

### Full Verification

```bash
bun run check  # typecheck + test
```

### Test Guidelines

- Tests live in `tests/` with `.test.ts` extension
- Use Bun's built-in test runner (`bun:test`)
- Mock external dependencies (filesystem, subprocesses)
- Test both success and error paths
- Aim for behavior-level testing, not implementation details

## Pull Request Process

1. **Ensure all tests pass:** `bun run check`
2. **Update documentation** if you changed behavior
3. **Update CHANGELOG.md** under `[Unreleased]`
4. **Write a clear PR description** explaining what and why
5. **Keep PRs focused** — one feature/fix per PR
6. **Respond to review feedback** promptly

### PR Checklist

- [ ] Tests pass (`bun run check`)
- [ ] No TypeScript errors (`bun run typecheck`)
- [ ] CHANGELOG.md updated
- [ ] Documentation updated (if applicable)
- [ ] No secrets or tokens in code

## Release

Releases are tag-driven. Nothing is published from a workstation.

1. **Land the change with its note.** Every pull request updates the `[Unreleased]`
   section of `CHANGELOG.md`.
2. **Cut the release in one commit** — `chore: release X.Y.Z`:
   - `package.json` → `version` (required),
   - `package-lock.json` → both `version` fields (convention: keeps the two lockfiles
     telling the same story; nothing gates it, since CI installs with Bun),
   - move `[Unreleased]` into a new `## [X.Y.Z] - <YYYY-MM-DD>` section and leave
     `[Unreleased]` empty for the next cycle,
   - add that version's link definition at the bottom and repoint `[Unreleased]` at it
     (`[Unreleased]: .../compare/vX.Y.Z...HEAD`) — cosmetic, and nothing checks it, which
     is exactly why it belongs in this same commit.
3. **Push `main`, then the tag:** `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. **CI does the rest.** `.github/workflows/release.yml` publishes to npm (Trusted
   Publishing + provenance) and opens the GitHub Release: its body is the changelog
   section for that version plus a `**Full Changelog**` compare link, and its only
   extra asset is the packed npm tarball (GitHub adds the source archives itself).

A release **fails before publishing** when the tagged commit has no `## [X.Y.Z]`
section. That is deliberate: a release must be describable at the commit it points at,
and the notes are the changelog — never a generated summary.

Never publish by hand. A locally published version carries no provenance and is not tied to its
tag, and npm's unpublish policy is deliberately restrictive — in practice a published version is
permanent.

### If a release fails

The tag is already public, so never move or delete it: fix forward with the next patch version.

| Symptom | What it means | What to do |
| --- | --- | --- |
| `Extract release notes` fails | The tagged commit has no `## [X.Y.Z]` section | Add the section, commit, and cut the next patch version |
| `Publish to npm` fails | Nothing reached the registry | Fix the cause and re-run the workflow — the publish step skips a version that already exists |
| `Verify the packed tarball` fails | The registry holds bytes you cannot reproduce from the tag | Treat the release as broken and investigate before doing anything else |
| `Publish the GitHub Release` fails | npm already has the version; only the GitHub Release is missing | Re-run the workflow — the release step finishes a leftover draft, refills a missing tarball, refreshes the body, or skips a published release |

## Upstream tracking

Pi releases faster than we upgrade the CLI we run, so three versions have to stay distinct:

| Layer | What it is | Where it lives |
| --- | --- | --- |
| Verification baseline | The release `bun run check` compiles and tests against | `devDependencies`, the `PI_VERSION` constant in `tests/package-dependencies.test.ts`, both lockfiles |
| Production runtime | The Pi the maintainers actually run | the installed CLI on each machine |
| Upstream probe | The newest release, typechecked but not run | results in `docs/upstream-baseline.md` |

The baseline is deliberately the production runtime: a green `bun run check` should say something about the CLI in use. `peerDependencies` stay `"*"`, because Pi supplies the host packages to installed extensions and upstream asks packages not to bundle or pin them.

Probe any release without touching the repository install:

```bash
bun run compat:upstream          # newest upstream release
bun run compat:upstream 0.99.1   # one exact release
bun run compat:upstream --keep   # keep the scratch tree, e.g. to read a failure
```

Exit code 0 means the extension's type surface still compiles against that release; 1 prints the compiler output. The weekly [Upstream watch](.github/workflows/upstream-watch.yml) workflow runs the `latest` probe outside the PR gate, so an upstream release never blocks normal work.

When the probe goes red, classify it before changing anything:

1. **We use something upstream removed or reshaped** — adapt the extension in the same change that raises the baseline.
2. **The breakage sits in code paths we never call** — record it in `docs/upstream-baseline.md` and leave the code alone.
3. **Types pass, behaviour is unknown** — a PASS is not a promise. Event timing, overlay lifecycles and audio paths still need a session on the production runtime.

Raise the baseline — `devDependencies`, the `PI_VERSION` constant, both lockfiles — in its own commit, when there is a reason: a feature we want, or a release we are moving to.

## Coding Standards

### TypeScript

- Use TypeScript strict mode
- Prefer `const` over `let`
- Use explicit return types for public functions
- Handle errors explicitly — no empty `catch {}` blocks (except cleanup)
- Use `node:` prefix for Node.js built-in imports

### General

- No hardcoded secrets or API keys
- No telemetry or analytics
- Keep error messages user-friendly

## Reporting Issues

### Bug Reports

Please include:

1. **Pi version** (`pi --version`)
2. **pi-voicekit version** (check in Pi or `bun pm ls pi-voicekit`)
3. **OS and architecture** (e.g., macOS 15.2, Apple Silicon)
4. **Steps to reproduce**
5. **Expected vs actual behavior**
6. **Output of `/voice test`**

### Feature Requests

- Describe the use case, not just the solution
- Explain how it fits with existing features
- Consider backward compatibility

---

## Recognition

Contributors are recognized in release notes and the project README. Thank you for helping make pi-voicekit better!
