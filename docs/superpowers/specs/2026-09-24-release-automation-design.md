# Design: Automatic release notes and release assets for pi-voicekit

- **Status**: reviewed 2026-09-25 (two self-review passes); awaiting maintainer approval
- **Date**: 2026-09-24
- **Scope owner**: repository maintainer
- **Selected route**: A — the hand-written `CHANGELOG.md` is the single source of truth
  for release notes (chosen by the maintainer over the alternatives ruled out in §7).

> This file lives under `docs/superpowers/`, which is intentionally **not committed**:
> it is listed in `.gitignore`, excluded from Prettier via `.prettierignore`, and
> excluded from pi-lens scans via `.pi-lens.json` → `ignore`. The brainstorming
> skill's default of committing the spec is deliberately overridden by the
> maintainer's local-isolation convention. Do not `git add` this file.
>
> `[needs verification]` marks a statement that is not yet backed by current-repo,
> current-environment, or primary-source evidence.

---

## 1. Problem

The repository publishes to npm from a tag push (`release.yml`), but the GitHub
side of a release is empty:

| Fact (measured 2026-09-24) | Evidence |
| --- | --- |
| GitHub has 3 tags, **0 releases** | `GET /repos/CyFeng16/pi-voicekit/releases` → `[]` |
| `CHANGELOG.md` is not in the published tarball | 0.1.3 tarball = 35 files: `extensions/**`, `LICENSE`, `package.json`, `README.md` |
| Release notes exist only inside the repo | hand-written `## [Unreleased]` / `## [x.y.z]` sections |
| No release tooling is wired | no changesets / semantic-release / release-please / commitlint / husky config |

So the work of "writing release notes" is already done by hand and then thrown
away: nothing carries it to where users read it, and no artifacts accompany the
tag.

## 2. Goals

1. One action — pushing a `v*` tag — produces a complete release: npm package
   (unchanged, still with provenance) **and** a GitHub Release carrying notes and
   the npm artifact.
2. The long-term answer to "where do release notes come from?" is written down and
   enforced, not remembered.
3. Contributors keep writing `[Unreleased]` exactly as today. Zero change to the
   contribution flow.

## 3. Invariants

These must hold in any implementation; a variant that breaks one is a deviation,
not a simplification.

1. **Single source.** The release body content originates only from the
   `CHANGELOG.md` section for that version. No commit-log synthesis, no PR-label
   categories, no second narrative.
2. **Proven byte identity.** The attached npm tarball must be byte-identical to
   the published artifact, and this must be *proved at release time* by a gate,
   never assumed.
3. **Fail before publishing.** Anything that can invalidate the release notes
   fails before `npm publish` runs.
4. **No automatic versioning.** Versions are bumped by hand, tags are pushed by
   hand. This design adds no bot PRs, no auto-bump, no auto-tag.
5. **Reproducible recovery.** A failure after publishing must be recoverable by
   re-running the workflow without manual surgery.

### 3.1 The human half (required precondition)

The step-4 gate only works if a release *has* a section, and nothing in the
pipeline can invent one. So the maintainer's release commit must do two things
together:

1. bump the version — `package.json` is the required one, and the two `version` fields
   in `package-lock.json` follow by convention (measured: every 0.1.x bump synced
   them; nothing gates it, since `bun.lock` records no version and CI installs with
   Bun), and
2. move the `[Unreleased]` content into a new `## [x.y.z] - <YYYY-MM-DD>` section,
   leaving `[Unreleased]` empty for the next cycle.

Convention: **one commit**, `chore: release X.Y.Z`, containing both, so the section
is guaranteed to be in the tagged commit's tree.

Measured — and this is a real behaviour change: the 0.1.x history does **not** do
that today. The `## [0.1.3]` and `## [0.1.2]` sections were added after the fact by
a later docs commit (`f8e5fec`), while the bump commits (`059ea5c`, `c9e0dbd`)
touched only `package.json` and `package-lock.json`. At the tagged commit of
v0.1.3 the section did not exist yet, so **v0.1.3 would have failed this gate**.
That is the intended behaviour rather than a regression — a release must be
describable at the commit it points at — and it means the acceptance release
(§6, item 5) is also the first release that has to follow the new rule.

Tagging a commit whose `CHANGELOG.md` lacks the section fails step 4 by design;
there is deliberately **no bypass flag**, and §5.1 is where the rule becomes
documented policy rather than tribal knowledge.

## 4. Design

### 4.1 Pipeline order

`release.yml` keeps its trigger (`push: tags: ["v*"]`) and gains steps in this
order:

```text
1. checkout (persist-credentials: false)
2. verify tag == package.json.version                        (existing, unchanged)
   VERSION=${GITHUB_REF#refs/tags/v}   →   $GITHUB_ENV, for every later step
3. setup Bun 1.3.11                                          (existing, unchanged)
4. extract CHANGELOG section for $VERSION -> $RUNNER_TEMP/release-notes.md
                                                             <-- fails fast
4b. append the **Full Changelog** compare line to that same file
5. bun install --frozen-lockfile && bun run check           (existing, unchanged)
6. setup-node 24 + npm@latest                               (existing, unchanged)
7. npm publish --provenance --access public                 (becomes idempotent)
8. npm pack; assert sha1 == registry dist.shasum   <-- identity gate; exports TGZ
9. gh release create --draft → attach tarball → gh release edit --draft=false
                                                 (a leftover draft is refilled and its
                                                  body refreshed before it is published)
```

Exact shapes, so the plan does not have to guess (sketch, not implemented):

```bash
# step 4 — fail fast when the section is missing
node scripts/changelog-entry.mjs "$VERSION" --file CHANGELOG.md \
  > "$RUNNER_TEMP/release-notes.md"

# step 4b — append the compare link; PREV is the greatest version below $VERSION
PREV="$(git ls-remote --tags origin 'refs/tags/v*' \
  | sed 's|.*refs/tags/||; s|\^{}||' | sort -u -V \
  | awk -v cur="v$VERSION" '$0 == cur { exit } { last = $0 } END { print last }')"
if [ -n "$PREV" ]; then
  printf '\n**Full Changelog**: %s/compare/%s...v%s\n' \
    "https://github.com/${{ github.repository }}" "$PREV" "$VERSION" \
    >> "$RUNNER_TEMP/release-notes.md"
fi

# step 7 — idempotent publish
if npm view "pi-voicekit@$VERSION" version >/dev/null 2>&1; then
  echo "$VERSION already on the registry — skipping publish"
else
  npm publish --provenance --access public
fi

# step 8 — identity gate
TGZ="$(npm pack --silent | tail -1)"
echo "TGZ=$TGZ" >> "$GITHUB_ENV"     # step 9 needs it; every run: block is its own shell
test "$(sha1sum "$TGZ" | cut -d' ' -f1)" \
  = "$(npm view "pi-voicekit@$VERSION" dist.shasum)"

# step 9 — idempotent, draft-aware, and distrustful of a draft's asset list
if OUT="$(gh release view "v$VERSION" --json isDraft -q .isDraft 2>&1)"; then
  if [ "$OUT" = "true" ]; then
    # A draft can carry an asset that is present by name and wrong: the upload endpoint
    # documents that an upstream failure "may leave an empty asset with a state of
    # starter", and a same-named asset must be replaced before it can be re-uploaded.
    # Never trust the name — re-upload the tarball step 8 just proved identical.
    gh release upload "v$VERSION" "$TGZ" --clobber
    gh release edit "v$VERSION" --notes-file "$RUNNER_TEMP/release-notes.md" --draft=false
  else
    echo "release v$VERSION already published — nothing to do"
  fi
elif printf '%s' "$OUT" | grep -qi 'not found'; then
  gh release create "v$VERSION" --draft --verify-tag --title "v$VERSION" \
    --notes-file "$RUNNER_TEMP/release-notes.md" "$TGZ"
  gh release edit "v$VERSION" --draft=false
else
  # a transient API or permission failure is not "the release does not exist"
  echo "::error::cannot determine the state of v$VERSION: $OUT"
  exit 1
fi
```

`--latest` / `--prerelease` are deliberately not set: GitHub assigns the *latest*
label by semantic version on its own.

Rationale for the ordering decisions:

- **Step 4 before step 7.** If the changelog section is missing, the run dies
  before anything irreversible happens. Putting extraction last would produce the
  worst half-state: published to npm, no release notes anywhere.
- **Step 7 idempotent.** `npm view pi-voicekit@$VERSION version` first; skip the
  publish when the version already exists. Without this, a re-run after a step-9
  failure dies at step 7 with `403 version already exists` and the release can
  never be completed by re-running.
- **Step 9 stays explicit, and its guard reads the draft state.** The runner's GitHub
  CLI does not have the problem an earlier draft of this section claimed: at v2.100.0
  `create.go` sets `draftWhileUploading = true` whenever assets are present and `-d`
  was not given, so it already creates the release as a draft, uploads, then publishes
  — and deletes the draft if any step fails. The explicit draft is kept for a
  different reason: it keeps every intermediate state ours to inspect and to resume.
  That is also why the guard must read `isDraft` — `gh release view` finds draft
  releases as well as published ones (its `FetchRelease` returns "a published
  repository release … or a draft release by its pending tag name"), so treating "a
  release exists" as "the release is done" is exactly how a run gets stuck on its own
  draft and breaks invariant 5.

### 4.2 Component: `scripts/changelog-entry.mjs`

One narrow job: version number in, that version's changelog body out.

| Aspect | Decision |
| --- | --- |
| Runtime | plain `.mjs`, runs on Node 24 (CI) and Bun 1.3.11 (local) with no build step |
| CLI | `node scripts/changelog-entry.mjs <version> [--file CHANGELOG.md]` |
| input normalization | `0.1.3`, `v0.1.3` and `[0.1.3]` are all accepted and normalized to `0.1.3`; `Unreleased` and `[Unreleased]` likewise. No other guessing — an unrecognized spelling is a usage error (exit 2), not a fuzzy match. |
| stdout | the section body **without** the `## [x.y.z] - date` heading line, trailing blank lines trimmed |
| exit codes | `0` found; `1` no such section, or the section is empty; `2` usage / unreadable file |
| boundary | section starts at the line matching `^## \[<version>\]` and ends before the next `^## ` line (so `### Added` etc. stay inside) |
| trailing block | drop trailing `[x.y.z]: https://…` link-definition lines if they fall inside the captured range |
| regex safety | the version must match exactly — `0.1.3` must not match `## [0.1.30]` |
| shipping | never shipped to npm — `package.json` → `files` is an allow-list that does not include `scripts/`, so this stays a repository-side tool |
| typecheck | `scripts/` sits outside `tsconfig.json`'s `include` (`extensions/**/*.ts`), so this stays plain, dependency-free JavaScript on purpose and is never typechecked |
| `[Unreleased]` | also extractable, so the text can be previewed before a release |

Why a script and not inline `awk`: it is the only piece with real edge cases
(section boundaries, the link-definition block, prefix collisions), and the repo
already has a test suite (`tests/*.test.ts`, `bun test`) that can pin them.

Tests — `tests/changelog-entry.test.ts`, mirroring the existing suite style:

1. returns the body of an existing version, heading excluded;
2. stops at the next `## ` heading and keeps `### ` subsections;
3. strips a trailing link-definition block;
4. exits 1 for an unknown version;
5. exits 1 for a present-but-empty section;
6. extracts `[Unreleased]`;
7. does not match a longer version that shares a prefix (`0.1.3` vs `0.1.30`);
8. accepts the `v0.1.3` / `[0.1.3]` / `Unreleased` spellings per the normalization row;
9. first match wins when a version appears twice;
10. tolerates a file with no trailing newline, and one with CRLF line endings;
11. exits 2 for a missing file, an unreadable file, and a missing argument;
12. matches the real `CHANGELOG.md` for every version it actually contains;
13. writes nothing but the body to stdout (CI pipes it straight into a file).

### 4.3 Release body

```
<body of the CHANGELOG section for this version>

**Full Changelog**: https://github.com/<owner>/<repo>/compare/<prev>...<tag>
```

- **Definition of "previous"**: the greatest tag version *strictly less than* the
  current one under `sort -V`. Derivation: `git ls-remote --tags origin`, keep
  `refs/tags/v*`, drop the `^{}` dereference entries, strip the `v` prefix, sort
  with `sort -V`, take the first entry below the current version. Omit the line
  entirely when there is none (the first release of a line).
- Known limitation: a tag created out of version order — a `v0.1.4` hotfix pushed
  after `v0.2.0` exists — still yields a correct *range* but not "everything since
  the previous release". Accepted at this project's cadence.
- `git ls-remote` needs no clone depth, so `actions/checkout` keeps its default
  shallow fetch (checked: deriving v0.1.3's predecessor yields v0.1.2).
- The compare URL is built from `${{ github.repository }}`, never a hardcoded slug,
  so a fork's release does not point back at this repository.
- Generated by **workflow step 4b**, which appends it to the same file the extractor
  filled: the script keeps its single job (§4.2) and stays a pure text transform.
- **No `--generate-notes`.** Generated notes categorise PRs and would create a
  second, machine-authored narrative next to the hand-written one, breaking
  invariant 1. If a PR list is ever wanted, it must be appended explicitly and
  remain clearly subordinate.

### 4.4 Release assets

| Asset | Source | Work |
| --- | --- | --- |
| `Source code (zip)` / `(tar.gz)` | GitHub, automatically, at the tag's tree | none — documented in *About releases* |
| `pi-voicekit-<version>.tgz` | `npm pack` in CI, ≈170 KB | new step + identity gate |

- Use **`npm pack`**, not `bun pm pack`. Measured: for v0.1.3, `npm pack`
  reproduces the published artifact exactly (sha1 `3eea444894dafd6b60f92b582670db368b6d3b1b`,
  integrity `sha512-Em+hWC+zeDMIPgbCp5wHRaPHxwhQBqWY…`), while `bun pm pack`
  produced a different file (sha1 `ab009885ab767f2d8406e0cf5cdeb6a69c1d9b90`).
- **Gate**: compare the packed tarball's sha1 against
  `npm view pi-voicekit@$VERSION dist.shasum` and fail if they differ. This turns
  "the bytes should be the same" into a checked fact at every release, and it
  covers future npm releases whose packing could change.
- No `SHA256SUMS` file: integrity is already published by the registry
  (`dist.integrity`) and, for immutable releases, GitHub adds a release
  attestation. Adding it would be unused ceremony.

**Considered and rejected**: `npm pack` first and `npm publish ./pi-voicekit-<v>.tgz`,
which makes the attachment the published artifact by construction. It changes the
proven, currently-working publish path and depends on npm's semantics for
publishing from a tarball (`gitHead` retention, lifecycle differences) — the
published 0.1.3 carries `gitHead: 059ea5c9de9ea1926b3ec623e4f18c7f70b81506`, which
is worth keeping. `[needs verification]` those semantics, if the maintainer ever
wants to switch.

### 4.5 Permissions and secret handling

- `permissions`: `contents: write` (new — required by step 9) plus the existing
  `id-token: write` (required by Trusted Publishing).
- `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` is injected **only in step 9's step-level
  `env`**. `bun install` executes dependency install scripts; deferring the token
  to the last step keeps those scripts unable to touch it.
- `actions/checkout` gains `persist-credentials: false`.
- Trigger surface unchanged: only `v*` tags, pushed by people with write access.
- No new external dependency: the runner image already ships GitHub CLI 2.100.0
  (verified against the ubuntu-24.04 image manifest), so no third-party action and
  no install step is added.
- The npm-side Trusted Publishing binding is keyed to this workflow's **file name**
  (`release.yml`), so it stays valid as long as the file keeps its name — renaming it
  would break publishing until the npm setting is updated to match.
- Both permissions stay **workflow-level**, as they are today, so the pair is stated
  once instead of being split across jobs.
- **Why not two jobs** (a publish job holding `id-token: write` and a release job
  holding `contents: write`): that would require passing the tarball and the notes
  file between jobs, adding a moving part whose only benefit is a narrower token
  per job. Deferring `GH_TOKEN` to the final step keeps the token out of the install
  and test steps' environments, which shrinks the surface — but it is **not**
  isolation: a step that appends to `$GITHUB_PATH` persists a directory for every
  later step, and with `id-token: write` granted workflow-wide any step in this job
  could request an OIDC token and publish to npm itself. The real mitigations are the
  frozen lockfile and the small dependency set, not the step order.

### 4.6 Failure modes and recovery

| Failure | State after | Recovery |
| --- | --- | --- |
| Step 4 — section missing/empty | nothing published | write the section, commit, and cut the next patch version — **never move or delete the tag**: it is already public, and a rewritten tag is a worse outcome than a burned version number (immutable releases block it outright) |
| Step 7 fails (auth/OIDC) | nothing published | fix config, re-run the workflow |
| Step 8 — shasum mismatch | published, no release | do **not** attach; investigate the packing difference, then attach manually or via re-run |
| Step 9 partially done | published; possibly a leftover draft | re-run the workflow — step 7 skips, step 8 re-verifies, and step 9 re-uploads the verified tarball into the leftover draft (`--clobber`, so a same-named but broken asset is replaced), refreshes the body, publishes it, or reports that the release is already published |
| Release published with wrong body | published | edit the release (notes stay editable even when immutable) |

Rollback of the change itself is a plain `git revert`: nothing in the design
mutates repository history or the registry. A published npm version cannot be
withdrawn, only deprecated — which is why invariant 3 puts every preventable
failure before step 7.

## 5. Documentation write-back

**Required** items are depended on by the pipeline itself; **optional** items are
adjacent cleanups that can ship separately.

1. **`CONTRIBUTING.md` — required; `AGENTS.md` — done (commit `bfd19d1`).** The essence now
   sits in `AGENTS.md` as a `## Releases` section — tag-driven only / never local,
   one source for release notes, one release commit. Deliberately three bullets:
   that file is auto-loaded into every session, so only stable rules with
   irreversible consequences earn the context cost. `CONTRIBUTING.md` still needs the
   full procedure §3.1 depends on: bump the version (`package.json`, plus the lockfile's
   two `version` fields by convention), move `[Unreleased]` into
   `## [x.y.z] - <date>` in the same `chore: release X.Y.Z` commit, push the tag, and
   the fact that CI publishes to npm and opens the GitHub Release (body from that
   section, npm tarball attached). Pull requests keep writing only `[Unreleased]`.
2. **`CHANGELOG.md` — optional, independently shippable.** Add the missing link
   definitions: measured, there are no `[Unreleased]` or `[0.1.x]` definitions at
   the bottom of the file, while Keep a Changelog (which the file declares it
   follows) requires versions and sections to be linkable, and the existing
   definitions all still point at the upstream `codexstar69/pi-listen` repository.
   New entries should link here. The pipeline does not depend on this.
3. **`package.json` — decided: remove `release`, keep `release:dry`.** `release`
   runs a local `bun publish --access public`, bypassing both the tag/version check
   and the OIDC provenance path CI uses — a second, undocumented release route.
   `release:dry` only validates locally and mutates nothing, so it stays; it is a
   packaging sanity check, not a rehearsal of the release.
4. **Repo-local convention — applied, then extended by the maintainer.**
   `docs/superpowers/` is in `.gitignore`, in `.prettierignore` and in
   `.pi-lens.json` → `ignore`. Two commits then landed on top of this work
   (`6c35a3d` pins `prettier` 3.3.3 as a devDependency; `1d7898f` commits
   `.prettierignore` and widens it with a repo-wide `**/*.md` block), so pi-lens'
   formatter no longer rewrites any markdown at all. Those two commits, and this
   repository's three follow-up commits, are all pushed: `origin/main` = `bfd19d1`.
5. **`llms.txt` / `llms-full.txt` — done (commit `dc57403`).** De-duplicated rather than
   extended: the stale v5.x-era inlined content was removed (`llms-full.txt` 164 →
   29 lines), one real drift fixed (the settings panel has 5 tabs, not 4), and a
   link to `AGENTS.md` added. Policy text is deliberately **not** mirrored there —
   a second copy is what drifted in the first place.

## 6. Verification plan

A workflow change cannot be fully exercised locally, so verification is layered
and the last layer is a real release:

1. **Unit** — `bun test tests/changelog-entry.test.ts` (all thirteen cases above).
2. **Dry run on real data** — run the extractor against the repository's own
   `CHANGELOG.md` for `0.1.3` and for `[Unreleased]`; diff the output against the
   file by eye. Expected: 0.1.3 yields the "Remote microphone capture" bullet.
3. **Static** — extract each new `run:` block into a file and check it with
   `bash -n`; confirm the edited workflow still parses as YAML and that `bun run
   check` still precedes the publish step.
4. **Registry-side gate rehearsal** — locally: `npm pack` in a clean tree of the
   tagged commit and compare sha1 with `npm view … dist.shasum` (this is exactly
   the step-8 command; already performed once for 0.1.3 and it matched).
5. **Real release smoke (acceptance)** — the next actual release (suggested 0.1.4)
   must show: release body equal to the CHANGELOG section **plus the appended
   `**Full Changelog**` compare line**; the attached tarball's
   sha1 equal to the registry `dist.shasum`; npm provenance still present;
   `Source code` archives present automatically. Mocked tests cannot stand in for
   this step.
6. **Repo gates unchanged** — verified at `bfd19d1`: `bun run check` = 309 tests passing
   with a clean typecheck, `bun run format:check` passes, and the CI run on the pushed
   tree (`36152361654`) is green on every step.

## 7. Non-goals

- Adopting changesets, release-please, or any changelog generator.
- Automatic version bumps, automatic tags, bot release PRs.
- Adding `CHANGELOG.md` to `package.json` → `files` (whether package consumers
  should be able to read the changelog in-place is a separate decision).
- Changing `ci.yml` behaviour.
- Touching upstream attribution, the MIT LICENSE, or the original-author credit.
- Modelling pre-release tags: `v*` also matches `v0.2.0-rc.1`, and the pipeline would
  simply look for a changelog section of that name. Deferred until the project cuts
  its first RC.

## 8. Open questions

1. Should the acceptance release be 0.1.4 (which would also ship the already-merged
   brand unification / README parity work), or should the first run be the release
   after next? **Decision point: before the first real release** — i.e. once the
   implementation plan is done and the first tag is about to be pushed.
2. ~~Should this policy be mirrored in `llms.txt` / `llms-full.txt`?~~ **Resolved — no.**
   The essence lives in `AGENTS.md`, the procedure is bound for
   `CONTRIBUTING.md`, and the `llms*` files carry a link only; both were cleaned of
   duplicated, drifted content instead (see §5, item 5).

## 9. Appendix — measured evidence

| Claim | How it was measured |
| --- | --- |
| Source archives are automatic | GitHub Docs, *About releases*: "GitHub will automatically include links to download a zip file and a tarball containing the contents of the repository at the point of the tag's creation." |
| `npm pack` reproduces the published tarball | `git archive v0.1.3` → `npm pack` → sha1 `3eea444…` / `sha512-Em+hWC+…`, equal to `dist.shasum` / `dist.integrity` |
| `bun pm pack` does not | same tree, `bun pm pack` → sha1 `ab009885…` |
| Published package excludes the changelog | downloaded 0.1.3 tarball: 35 entries, no `CHANGELOG.md` |
| No GitHub Releases exist | `GET /repos/CyFeng16/pi-voicekit/releases` → `[]`; tags v0.1.1–v0.1.3 |
| `gh` needs no install | ubuntu-24.04 runner image manifest lists GitHub CLI 2.100.0 |
| Immutable releases are opt-in and asset-frozen | GitHub Docs, *Immutable releases*; recommended flow = draft → attach → publish |
| Predecessor tag derivation | `git tag -l 'v*' --sort=-v:refname` → v0.1.3, v0.1.2, v0.1.1, so the greatest version below v0.1.3 is v0.1.2. The workflow derives it without a local clone (`git ls-remote --tags origin 'refs/tags/v*'` → `sed` → `sort -u -V` → `awk`); re-run locally with the real tag list: `VERSION=0.1.3` → `v0.1.2`, `VERSION=0.1.1` → empty |
| `gh release create` with assets already drafts-then-publishes | upstream source `cli/cli@v2.100.0` `pkg/cmd/release/create/create.go`: `if hasAssets && !opts.Draft { draftWhileUploading = true; params["draft"] = true }` → `ConcurrentUpload` → `if draftWhileUploading { publishRelease }`, with `cleanupDraftRelease` deleting the draft when anything fails |
| `.prettierignore` exempts an ignored file even when passed explicitly | prettier 3.3.3 run from the repo root with an absolute path: file unchanged, exit 0 |
| pi-lens `ignore` exempts scans | two byte-identical markdown files, one inside `docs/superpowers/`, one at the repo root: pi-lens reported the MD041 finding only for the root file |
| `.pi-lens.json` `ignore` is in effect | `effective_config` provenance: `{"/ignore","tier":"project","file":"~/workspace/pi-voicekit/.pi-lens.json"}` |
| pi-lens' autoformat does not consult that matcher | `dist/clients/pipeline.js`: the format branch reads only `no-autoformat` / `format.mode`; the ignore matcher is used by scan paths (startup-scan, tree-sitter, review-graph, diagnostics collection) |
| Deferred-format end-to-end check | **Inconclusive, and now moot.** Neither the messy *control* at the repo root nor its byte-identical canary under `docs/superpowers/specs/` was rewritten across two turn boundaries — this workspace's deferred pass processed neither file, so the canary could never discriminate. The load-bearing evidence stays the direct-invocation test above (prettier invoked exactly as pi-lens builds the command: repo-root cwd, absolute path). Independently, `1d7898f` widened `.prettierignore` with `**/*.md`, which removes that class of write entirely. |
| 0.1.x wrote its changelog sections after the tag | `git log -S '## [0.1.3]' -- CHANGELOG.md` → `f8e5fec` (a later docs commit); bump commit `059ea5c` touched only `package.json` + `package-lock.json` |
| Every published version came from CI | npm attestations for 0.1.1 / 0.1.2 / 0.1.3 all name `.github/workflows/release.yml` — local publishing is dead in practice, yet `package.json` still exposes it (§5, item 3) |
| CI is green on the pushed tree | run `36152361654` for `bfd19d1`: Install dependencies / Typecheck + tests / Check formatting all succeeded |
| A version bump cannot desync `bun.lock` | `bun.lock`'s root workspace entry carries `name`, deps, optionalDeps and peerDeps but **no `version`** field; `package-lock.json` carries the version twice (top level and `packages[""]`), which is exactly what every 0.1.x bump commit edited |
