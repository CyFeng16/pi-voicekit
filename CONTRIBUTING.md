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
│       ├── config.ts          # Config loading, saving, migration
│       ├── deepgram.ts        # Deepgram URL builder, API key resolver
│       ├── onboarding.ts      # First-run setup wizard
│       └── text-processing.ts # Voice command detection, punctuation shortcuts
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
fix: prevent orphan daemon process on startup timeout
docs: update backend comparison table
test: add config migration edge cases
refactor: extract socket path generation to config module
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
