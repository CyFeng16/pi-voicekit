# Evidence for Plan — release automation (release notes + release assets)

- **evidence_status**: COMPLETE
- **spec_source**: `docs/superpowers/specs/2026-09-24-release-automation-design.md` — sha256
  `c5b4618f22cc59f53e8e7bff1c10ceacba373551436026ee4aa6260f82b5b1a3`, repo HEAD `bfd19d1`
  (= `origin/main`), `CHANGELOG.md` sha256 `9f79d51800babbfe…`
- **scope_note**: only the unknowns that would change the plan's component boundaries,
  dependency order or verification strategy. Normative spec content is treated as a
  constraint, not re-litigated; this package does not converge or amend the spec.
- **sources_checked**: repo reads / `rg` / `git` / live `gh`; primary external sources (gh CLI
  `v2.100.0` source, ubuntu-24.04 runner image manifest, npm docs); two throwaway spikes under
  `/tmp/ev-spike` (no repository writes).

## Findings

| # | question | disposition | evidence | plan_effect |
|---|---|---|---|---|
| 1 | Does the §4.2 extractor contract hold on the **real** `CHANGELOG.md`? | VERIFIED | throwaway implementation (45 lines, `/tmp/ev-spike/extract.mjs`) run against the real file: `0.1.3` → exit 0, 6 lines, contains "Remote microphone capture", no leakage from the `0.1.2` section; `Unreleased` → exit 0, 14 lines; the **last** section `3.0.0`, which sits directly above the `[x.y.z]: https://…` link-definition block → exit 0, 21 lines, **0 residual link-definition lines** | write the script exactly to §4.2, no contract change. One point the spec leaves open: the captured body starts with the blank line that follows the heading — trim leading blanks (cosmetic, both render fine) |
| 2 | Are the §4.2 boundary cases real, and are the exit codes distinguishable? | VERIFIED | synthetic fixtures: `0.1.3` vs `## [0.1.30]` → correct section only, no prefix collision; duplicate sections → first wins; CRLF → exit 0; no trailing newline → exit 0; present-but-empty section → exit 1 `section present but empty`; unknown version → exit 1 `no section for …`; unreadable file → exit 2; missing argument → exit 2; `v0.1.3` and `[0.1.3]` normalise byte-identically to `0.1.3` | the 13 test cases in §4.2 are sufficient as written; no extra test class needed |
| 3 | Can a `.mjs` script be tested by the repo's own runner (decides the language choice)? | VERIFIED | spike: `lib.mjs` plus a `lib.test.ts` that imports it → `bun test` → `1 pass / 0 fail` | keep plain `.mjs`; no build step, `tsconfig.json` (`include: extensions/**/*.ts`) stays untouched |
| 4 | Is `node` available to the extract step, which runs **before** `actions/setup-node`? | VERIFIED | ubuntu-24.04 runner image manifest lists `- Node.js 22.23.2` | step 4 may call `node scripts/changelog-entry.mjs`; no reordering needed (calling `bun`, already set up at step 3, is unnecessary) |
| 5 | Does `git ls-remote` still work under `persist-credentials: false`? | VERIFIED | `GIT_TERMINAL_PROMPT=0 git -c credential.helper= ls-remote https://github.com/CyFeng16/pi-voicekit 'refs/tags/v*'` → exit 0, tags listed | step 4b needs no credentials **because the repository is public** — carry that as an assumption with a named failure mode (a private repository would need an explicit token) |
| 6 | Does the runner's `gh` support the draft-aware guard (`--json isDraft`, `edit --draft=false`)? | VERIFIED | upstream `cli/cli@v2.100.0`: `shared.ReleaseFields` contains the string `"isDraft"` (`pkg/cmd/release/shared/fetch.go:31`); `release edit` declares `NilBoolFlag(…, "draft", …)` (`pkg/cmd/release/edit/edit.go:76`). Locally gh 2.45.0 — which *validates* field names, a bogus one errors `Unknown JSON field: "bogusFieldXyz"` — accepts `--json isDraft` and returns empty for an absent release | the §4.1 guard is implementable as specified on both versions; the `IsDraft` identifier appearing in a rendering path was **not** treated as proof of the JSON field |
| 7 | Can `npm pack` in CI pick up anything outside the published artifact? | VERIFIED | `package.json` → `files` is an allow-list (`extensions`, `README.md`, `LICENSE`, `package.json`); npm docs list `node_modules` under "Some files are always ignored by default"; the 0.1.3 tarball has exactly 35 entries | no cleanup step is needed before `npm pack`; step 8's shasum gate remains the safety net |
| 8 | Is the pre-change baseline green? | VERIFIED | CI run `36152361654` on `bfd19d1`: Install dependencies / Typecheck + tests / Check formatting all succeeded; locally `bun run check` = 309 pass / 0 fail | the plan's first task can assume a green baseline, so any later red is attributable to the change |
| 9 | Must the release commit also touch the lockfiles? | VERIFIED | `bun.lock`'s root workspace entry carries `name`/deps but **no `version`**; `package-lock.json` carries the version twice | `package.json` is required; syncing `package-lock.json` is convention only — the plan must not turn it into a gate |
| 10 | Which release is the acceptance release? | DECISION_REQUIRED | spec §8 item 1 leaves it open and records the decision point (before the first real release) | the plan must not hardcode `0.1.4`; the first-release task takes the version as an input |
| 11 | `docs/superpowers/` is gitignored, yet this package is committed inside it | REFUTED (the stated convention) / SPEC_CHANGE | `.gitignore:5 docs/superpowers/`; the spec header says "intentionally **not committed** … Do not `git add` this file" | the spec header's absolute claim is now inaccurate for this subtree: either it gains a nuance (spec stays local, evidence/plan are tracked) or this commit is reverted and the package stays local |

## Unresolved or deferred

- **CI-side shasum gate at a real release.** `npm pack` byte-identity is verified for the
  v0.1.3 tree (sha1 `3eea444…` = registry `dist.shasum`), but a *future* tarball's identity is
  only knowable at release time. Owner: whoever runs the first release. First consumption
  point: pipeline step 8. Minimum action: read that step's output; closure if it fails is to
  stop the release (nothing is attached) and diff the packed listing against `files`.
- **The runner's `gh` at release time.** Verified against published v2.100.0 source and the
  image manifest, not against a live runner. First consumption point: step 9. Failure is loud
  (the guard errors); closure: read the draft state via
  `gh api repos/:owner/:repo/releases/tags/:tag`.
- **npm-side Trusted Publishing binding.** Not reachable without npm account access; indirectly
  evidenced by 0.1.1–0.1.3 having been published from this workflow file. Unaffected as long
  as `release.yml` keeps its name.

## Downstream impact

- **PLAN_INPUT** — findings 1–9. They fix the component boundary (one new `scripts/*.mjs` plus
  one test file plus workflow edits), the dependency order (extract → publish → pack/gate →
  release), and the verification strategy (unit tests, `bash -n` on the sketch, real-release
  smoke). The spec's step numbering and file layout can be used as-is.
- **HUMAN_DECISION** — finding 10: the acceptance release version, at the decision point the
  spec already records.
- **SPEC_CHANGE** — finding 11 (minor, documentation only): the spec header's isolation note
  contradicts this committed package.
- **DEFERRED_TO_IMPLEMENTATION** — trimming the leading blank line in the extractor output.
  (The `node` vs `bun` choice for step 4 is settled in favour of `node` by finding 4, so no
  branch remains.)

## Recommended next action

- **action**: WRITE_PLAN
- **authority**: ADVISORY
- **rationale**: every load-bearing unknown the plan would otherwise have to guess has a
  VERIFIED disposition with a reproducible command (findings 1–9). The two remaining items are
  a user decision at a later gate (10) and a documentation nuance (11); neither changes the
  component boundary, the dependency order or the verification strategy.

## Stop reason

All declared questions are dispositioned. Both throwaway spikes finished inside the time box
and their artifacts live only in `/tmp/ev-spike`. Further evidence would not change the plan's
task boundaries; what remains is consumed at the first real release and has named closure
paths. This package is ADVISORY and carries no phase-gate authority.
