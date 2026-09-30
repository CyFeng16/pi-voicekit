# Upstream baseline log

What this repository is verified against, and how the newest upstream Pi looked the last time we probed
it. Update this file whenever the picture changes — see
[CONTRIBUTING.md → Upstream tracking](../CONTRIBUTING.md#upstream-tracking).

## Verification baseline

The release `bun run check` and the pin test are held to.

| Since | Baseline | Why |
| --- | --- | --- |
| 2026-09-30 | 0.87.1 | The production runtime. The repository compiled against 0.85.0 while every real session ran 0.87.1. |

## Probe results

`bun run compat:upstream <version|latest>` — the type surface only, never a session.

| Date | Target | Resolved | Verdict | Note |
| --- | --- | --- | --- | --- |
| 2026-09-30 | latest | `@earendil-works/pi-coding-agent` 0.99.1, `@earendil-works/pi-tui` 0.99.1 | PASS | The 0.86/0.87 breaking changes (turn boundaries, the `SessionEntry` union, provider context) do not touch the APIs this extension uses, and `message_update` / `message_end` / `turn_end` still carry `message`. Not verified in a real session: event timing, overlay lifecycles and audio behaviour are outside what a typecheck can see. |
