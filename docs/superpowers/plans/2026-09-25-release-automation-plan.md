# Release Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one pushed `vX.Y.Z` tag produce a complete release — the npm package (unchanged, still with provenance) plus a GitHub Release whose body is that version's `CHANGELOG.md` section and which carries the packed npm tarball as an asset.

**Architecture:** A single new repository-side script (`scripts/changelog-entry.mjs`) turns "version number" into "release-notes body", and `.github/workflows/release.yml` gains four steps that call it, prove the packed tarball is byte-identical to the published one, and publish a GitHub Release through `gh` (draft-first, draft-aware guard). Nothing is generated from commit history; `CHANGELOG.md` stays the only source of release notes.

**Tech Stack:** Bun 1.3.11 (tests, scripts), Node 22.23.2 from the runner image, plain ESM `.mjs` (no build step), GitHub Actions, `gh` CLI 2.100.0 (preinstalled on the runner), npm 11.x with Trusted Publishing + provenance.

**Spec:** `docs/superpowers/specs/2026-09-24-release-automation-design.md` (sha256 `c5b4618f22cc59f53e8e7bff1c10ceacba373551436026ee4aa6260f82b5b1a3`) — the plan argues from it, so read both. Pre-plan evidence package: `docs/superpowers/plans/2026-09-25-release-automation-evidence.md`.

## Global Constraints

- **Repo language is English** — commit messages, code comments, docs. Conventional Commits (`type(scope): summary`), English, no AI attribution trailers.
- **Gate:** `bun run check` (= `bunx tsc -p tsconfig.json` + `bun test`) must pass; CI also runs `bun run format:check` over `**/*.{ts,json,yml,yaml}`.
- **Formatting:** tabs, double quotes, `printWidth: 120`, `trailingComma: "es5"`, prettier 3.3.3 as a pinned devDependency. Markdown is hand-formatted and excluded via `.prettierignore` (`**/*.md`) — never run prettier over `.md`.
- **Never publish locally.** `bun publish` / `npm publish` from a workstation bypasses the tag check and the OIDC provenance path. Releases happen only through the tag → CI path.
- **`CHANGELOG.md` is the single source of release notes.** No commit-log synthesis, no `--generate-notes`, no PR-label categories.
- **`ci.yml` is not touched.** Only `release.yml` changes.
- **`docs/superpowers/` is local working material.** `.gitignore` excludes it; the evidence package is tracked only because it was force-added deliberately. Do not `git add -A` anything from that tree.
- **Never weaken the fail-fast ordering:** extract → publish → pack/gate → release.
- **Verification one-liners must fail loudly.** `bun -e` scripts that use `require(...)` swallow uncaught
  exceptions: the process exits 0, prints nothing, and the work is silently skipped (measured on bun
  1.3.11; the `import` form, `await Bun.file(...)` and `node -e` all exit 1 correctly). Report failures with
  `console.error(...)` + `process.exit(1)`, never a bare `throw`.

## Review Focus

Five inputs/failure modes the spec implies but whose tests live outside `ChangelogEntry`'s own unit suite — the most likely to bite a maintainer. Each is pinned to the task that owns the code (see the referenced step), and none may be skipped.

1. **A tag whose changelog section is absent or whitespace-only.** Expected: the run dies before `npm publish`, with a message naming the version. → Task 1, Step 1 (cases 4 and 5) and Task 2, Step 3 (the ordering assertion that extraction precedes publishing).
2. **A previous run left a draft release.** Expected: re-running publishes that draft — with the verified tarball in it — instead of reporting "nothing to do". → Task 2, Step 1 (the guard), Task 2, Step 6 (the stub rehearsal) and **Task 5, Step 1 (the rehearsal against the real API)**.
3. **No previous tag at all (the first release of a line).** Expected: no `**Full Changelog**` line, and the run still succeeds. → Task 2, Step 4 (synthetic tag list).
4. **Tag names that share a prefix (`v0.1.3` vs `v0.1.30`).** Expected: the extractor picks the exact section and the compare-link derivation picks the correct predecessor. → Task 1, Step 1 (case 7) and Task 2, Step 4.
5. **`npm pack --silent` printing more than the file name.** Expected: the gate fails loudly rather than uploading the wrong path. → Task 2, Step 5.

---

### Task 1: The changelog entry extractor

**Files:**
- Create: `scripts/changelog-entry.mjs`
- Create: `tests/changelog-entry.test.ts`

**Interfaces:**
- Consumes: nothing (pure module + CLI).
- Produces: `normalizeVersion(input: string): string` and `extractEntry(markdown: string, version: string): { status: "ok"; body: string } | { status: "missing" } | { status: "empty" }`, imported by the test file and by the CI step as a CLI: `node scripts/changelog-entry.mjs <version> [--file CHANGELOG.md]` → stdout body, exit `0` ok / `1` missing-or-empty / `2` usage-or-unreadable.

- [ ] **Step 1: Write the failing test**

```ts
// tests/changelog-entry.test.ts
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { extractEntry, normalizeVersion } from "../scripts/changelog-entry.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURE = [
	"# Changelog",
	"",
	"## [Unreleased]",
	"",
	"### Changed",
	"",
	"- unreleased work",
	"",
	"## [0.1.30] - 2026-01-01",
	"",
	"- thirty",
	"",
	"## [0.1.3] - 2026-01-02",
	"",
	"### Fixed",
	"",
	"- three",
	"",
	"## [0.1.3] - 2026-01-03",
	"",
	"- duplicate three",
	"",
	"## [0.1.2] - 2026-01-04",
	"",
	"## [3.0.0] - 2020-01-01",
	"",
	"- ancient",
	"",
	"[0.1.3]: https://example.test/compare/v0.1.2...v0.1.3",
	"[3.0.0]: https://example.test/releases/tag/v3.0.0",
	"",
].join("\n");

test("normalises the accepted spellings to a bare version", () => {
	expect(normalizeVersion("0.1.3")).toBe("0.1.3");
	expect(normalizeVersion("v0.1.3")).toBe("0.1.3");
	expect(normalizeVersion("[0.1.3]")).toBe("0.1.3");
	expect(normalizeVersion("Unreleased")).toBe("Unreleased");
	expect(normalizeVersion("[Unreleased]")).toBe("Unreleased");
});

test("returns the body of a version without its heading", () => {
	const result = extractEntry(FIXTURE, "0.1.3");
	expect(result.status).toBe("ok");
	expect(result).toEqual({ status: "ok", body: "### Fixed\n\n- three\n" });
});

test("stops at the next h2 and keeps h3 subsections", () => {
	const result = extractEntry(FIXTURE, "Unreleased");
	expect(result).toEqual({ status: "ok", body: "### Changed\n\n- unreleased work\n" });
});

test("strips a trailing link-definition block", () => {
	const result = extractEntry(FIXTURE, "3.0.0");
	expect(result).toEqual({ status: "ok", body: "- ancient\n" });
});

test("reports a missing version", () => {
	expect(extractEntry(FIXTURE, "9.9.9")).toEqual({ status: "missing" });
});

test("reports a present but empty section", () => {
	expect(extractEntry(FIXTURE, "0.1.2")).toEqual({ status: "empty" });
});

test("does not match a longer version that shares a prefix", () => {
	expect(extractEntry(FIXTURE, "0.1.30")).toEqual({ status: "ok", body: "- thirty\n" });
	const wanted = extractEntry(FIXTURE, "0.1.3");
	expect(wanted.status === "ok" && wanted.body.includes("thirty")).toBe(false);
});

test("first match wins when a version appears twice", () => {
	const result = extractEntry(FIXTURE, "0.1.3");
	expect(result.status === "ok" && result.body.includes("duplicate three")).toBe(false);
});

test("tolerates CRLF and a missing trailing newline", () => {
	expect(extractEntry("## [0.2.0] - x\r\n\r\n- crlf\r\n", "0.2.0")).toEqual({
		status: "ok",
		body: "- crlf\n",
	});
	expect(extractEntry("## [0.3.0] - x\n\n- no newline", "0.3.0")).toEqual({
		status: "ok",
		body: "- no newline\n",
	});
});

test("accepts the v-prefixed and bracketed spellings", () => {
	expect(extractEntry(FIXTURE, "v0.1.3")).toEqual(extractEntry(FIXTURE, "[0.1.3]"));
});

test("returns the body for every version the real CHANGELOG.md actually contains", () => {
	const markdown = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
	const versions = [...markdown.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1]);
	expect(versions).toContain("0.1.3");
	for (const version of versions) {
		const result = extractEntry(markdown, version);
		expect(result.status).not.toBe("missing");
		// `[Unreleased]` is legitimately empty between releases — the release commit
		// empties it. A shipped version never is, and the workflow gates on exactly
		// that: an empty section must not be allowed to pass the suite.
		if (version !== "Unreleased") expect(result.status).toBe("ok");
	}
});

// --- CLI contract: these exit codes are the workflow's fail-fast mechanism ---

const SCRIPT = fileURLToPath(new URL("../scripts/changelog-entry.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const run = (...cliArgs: string[]) => spawnSync("node", [SCRIPT, ...cliArgs], { cwd: REPO_ROOT, encoding: "utf8" });

test("exits 2 with no version, an unknown option, an extra argument, or a bare --file", () => {
	const bare = run();
	expect(bare.status).toBe(2);
	expect(bare.stderr).toContain("usage:");
	expect(bare.stdout).toBe("");
	expect(run("0.1.3", "--nope").status).toBe(2);
	expect(run("0.1.3", "extra").status).toBe(2);
	expect(run("0.1.3", "--file").status).toBe(2);
});

test("exits 2 on an unrecognized version spelling", () => {
	const result = run("latest");
	expect(result.status).toBe(2);
	expect(result.stderr).toContain("unrecognized version spelling");
});

test("exits 1 when the section is missing, naming the version", () => {
	const result = run("9.9.9");
	expect(result.status).toBe(1);
	expect(result.stderr).toContain("no section for 9.9.9");
	expect(result.stdout).toBe("");
});

test("exits 2 for an unreadable file, 0 with only the body on stdout for a real one", () => {
	expect(run("0.1.3", "--file", "nope.md").status).toBe(2);

	const ok = run("0.1.3");
	expect(ok.status).toBe(0);
	expect(ok.stderr).toBe("");
	const expected = extractEntry(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"), "0.1.3");
	if (expected.status !== "ok") throw new Error("fixture assumption: CHANGELOG.md has a 0.1.3 section");
	expect(ok.stdout).toBe(expected.body);
	expect(ok.stdout.startsWith("## ")).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/changelog-entry.test.ts`
Expected: FAIL — `Cannot find module '../scripts/changelog-entry.mjs'`.

- [ ] **Step 3: Write the minimal implementation**

```js
#!/usr/bin/env node
// scripts/changelog-entry.mjs
//
// Version number in, that version's CHANGELOG.md body out. Repository-side tool:
// `package.json` -> `files` is an allow-list that does not include `scripts/`, so
// this never ships to npm consumers.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const VERSION_PATTERN = /^\[?(?:v?\d+\.\d+\.\d+|Unreleased)\]?$/;
const USAGE = "usage: node scripts/changelog-entry.mjs <version> [--file CHANGELOG.md]";

export function normalizeVersion(input) {
	return String(input).trim().replace(/^\[|\]$/g, "").replace(/^v/, "");
}

export function extractEntry(markdown, version) {
	const wanted = normalizeVersion(version);
	const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const heading = new RegExp(`^## \\[${escaped}\\](\\s|$)`);
	const lines = markdown.split(/\r?\n/);

	const start = lines.findIndex((line) => heading.test(line));
	if (start === -1) return { status: "missing" };

	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^## /.test(lines[i])) {
			end = i;
			break;
		}
	}

	const body = lines.slice(start + 1, end);
	const isTrailer = (line) => line.trim() === "" || /^\[[^\]]+\]:\s*\S+/.test(line);
	while (body.length && isTrailer(body[body.length - 1])) body.pop();
	while (body.length && body[0].trim() === "") body.shift();

	return body.length ? { status: "ok", body: `${body.join("\n")}\n` } : { status: "empty" };
}

function main(argv) {
	let version = null;
	let file = "CHANGELOG.md";
	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--file") {
			file = argv[++i] ?? "";
			if (!file) {
				console.error(USAGE);
				return 2;
			}
		} else if (argv[i].startsWith("--")) {
			console.error(`unknown option: ${argv[i]}`, USAGE);
			return 2;
		} else {
			positional.push(argv[i]);
		}
	}
	if (positional.length !== 1) {
		console.error(USAGE);
		return 2;
	}
	version = positional[0];
	if (!VERSION_PATTERN.test(version)) {
		console.error(`unrecognized version spelling: ${version}`);
		return 2;
	}

	let markdown;
	try {
		markdown = readFileSync(file, "utf8");
	} catch {
		console.error(`unreadable: ${file}`);
		return 2;
	}

	const result = extractEntry(markdown, version);
	if (result.status === "missing") {
		console.error(`no section for ${normalizeVersion(version)} in ${file}`);
		return 1;
	}
	if (result.status === "empty") {
		console.error(`section present but empty: ${normalizeVersion(version)} in ${file}`);
		return 1;
	}

	process.stdout.write(result.body);
	return 0;
}

const invokedDirectly = process.argv[1]
	? import.meta.url === pathToFileURL(process.argv[1]).href
	: false;
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/changelog-entry.test.ts`
Expected: PASS — 15 tests, 0 failures.

- [ ] **Step 5: Prove it on the real file, both directions**

```bash
node scripts/changelog-entry.mjs 0.1.3            # -> "### Fixed" … "Remote microphone capture" bullet, nothing from 0.1.2
node scripts/changelog-entry.mjs 9.9.9; echo $?   # -> "no section for 9.9.9 in CHANGELOG.md", exit 1
node scripts/changelog-entry.mjs 0.1.2; echo $?   # -> section exists and is non-empty, exit 0
```

Expected: the `0.1.3` body contains `Remote microphone capture` and not `Prettier enforced`; the unknown version exits `1`.

- [ ] **Step 6: Run the repo gate and commit**

```bash
bun run check
git add scripts/changelog-entry.mjs tests/changelog-entry.test.ts
git commit -m "feat(scripts): extract a version's changelog section for release notes"
```

---

### Task 2: The release workflow

**Files:**
- Modify: `.github/workflows/release.yml` (whole file — it is short, and the step order matters)

**Interfaces:**
- Consumes: `scripts/changelog-entry.mjs` (Task 1) as a CLI.
- Produces: a workflow that exports `VERSION` (from the tag) and `TGZ` (from `npm pack`) through `$GITHUB_ENV` for later steps; the release body file lives at `$RUNNER_TEMP/release-notes.md`. Task 5 consumes the published result.

- [ ] **Step 1: Replace the workflow with the final content**

```yaml
name: Release

on:
  push:
    tags: ["v*"]

permissions:
  contents: write
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          persist-credentials: false

      - name: Verify tag matches package.json version
        run: |
          TAG="${GITHUB_REF#refs/tags/}"
          VERSION="$(node -p "require('./package.json').version")"
          if [ "${TAG#v}" != "$VERSION" ]; then
            echo "::error::tag ${TAG} does not match package.json version ${VERSION}"
            exit 1
          fi
          echo "VERSION=$VERSION" >> "$GITHUB_ENV"

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.11

      # Fails before anything is published: a release must be describable at the
      # commit it points at. Step 4b (the compare link) is folded in here — it
      # writes to the same file and adds no state of its own.
      - name: Extract release notes from CHANGELOG.md
        run: |
          node scripts/changelog-entry.mjs "$VERSION" --file CHANGELOG.md \
            > "$RUNNER_TEMP/release-notes.md"

          PREV="$(git ls-remote --tags origin 'refs/tags/v*' \
            | sed 's|.*refs/tags/||; s|\^{}||' | sort -u -V \
            | awk -v cur="v$VERSION" '$0 == cur { exit } { last = $0 } END { print last }')"
          if [ -n "$PREV" ]; then
            printf '\n**Full Changelog**: %s/compare/%s...v%s\n' \
              "https://github.com/${GITHUB_REPOSITORY}" "$PREV" "$VERSION" \
              >> "$RUNNER_TEMP/release-notes.md"
          fi

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Typecheck + tests
        run: bun run check

      - name: Setup Node (npm ≥ 11.5.1 supports OIDC publish)
        uses: actions/setup-node@v6
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org

      - name: Bump npm to latest (supports OIDC)
        run: npm install -g npm@latest

      - name: Publish to npm (Trusted Publishing + provenance)
        run: |
          if npm view "pi-voicekit@$VERSION" version >/dev/null 2>&1; then
            echo "$VERSION already on the registry — skipping publish"
          else
            npm publish --provenance --access public
          fi

      - name: Verify the packed tarball matches the published one
        run: |
          TGZ="$(npm pack --silent | tail -1)"
          case "$TGZ" in
            pi-voicekit-*.tgz) ;;
            *) echo "::error::unexpected npm pack output: $TGZ"; exit 1 ;;
          esac
          echo "TGZ=$TGZ" >> "$GITHUB_ENV"
          LOCAL="$(sha1sum "$TGZ" | cut -d' ' -f1)"
          REMOTE="$(npm view "pi-voicekit@$VERSION" dist.shasum)"
          if [ "$LOCAL" != "$REMOTE" ]; then
            echo "::error::packed tarball $LOCAL != published $REMOTE"
            exit 1
          fi
          echo "$TGZ sha1 $LOCAL matches the registry"

      - name: Publish the GitHub Release
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          if OUT="$(gh release view "v$VERSION" --json isDraft -q .isDraft 2>&1)"; then
            if [ "$OUT" = "true" ]; then
              # A draft left by an earlier run can carry an asset that is present by name and
              # wrong: the upload endpoint documents that an upstream failure may leave an empty
              # asset behind, and a same-named asset must be replaced before it can be
              # re-uploaded. So never trust the name — re-upload the tarball just verified.
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
            # A transient API or permission failure is not "the release does not exist":
            # falling through to create would collide with it or hide the real error.
            echo "::error::cannot determine the state of v$VERSION: $OUT"
            exit 1
          fi

      # One-time prerequisites (npmjs.com side, done by the maintainer, not in CI):
      #   1. Claim/create the pi-voicekit package (npm access public happens at publish)
      #   2. Configure Trusted Publishing for it — npm binds by owner/repo/workflow
      #      FILE NAME, case-sensitive, so this file must stay release.yml:
      #      - Provider: GitHub Actions
      #      - Owner: CyFeng16     Repository: pi-voicekit
      #      - Workflow: release.yml
      #   3. OIDC GA (2025-07-31) requires npm >= 11.5.1 + Node >= 22.14.0; this
      #      workflow uses Node 24 and upgrades npm explicitly.
```

- [ ] **Step 2: Verify the YAML parses and every new `run:` block is valid shell**

```bash
bun -e "const fs=require('node:fs'); const fail=(m)=>{console.error(m);process.exit(1)}; const d=Bun.YAML.parse(fs.readFileSync('.github/workflows/release.yml','utf8')); const s=d?.jobs?.publish?.steps??[]; const names=s.map((x)=>x.name??x.uses); const want=['Verify tag matches package.json version','Setup Bun','Extract release notes from CHANGELOG.md','Install dependencies','Typecheck + tests','Bump npm to latest (supports OIDC)','Publish to npm (Trusted Publishing + provenance)','Verify the packed tarball matches the published one','Publish the GitHub Release']; if (s.length!==11) fail('expected 11 steps (1 checkout + 10 named), got '+s.length); for (const w of want) if (!names.includes(w)) fail('missing step: '+w); console.log('yaml parses; steps:', s.length)"
bunx tsc -p tsconfig.json
# Syntax-check every inline script ON ITS OWN — concatenating them would hide exactly
# the cross-step mistakes (an unexported variable) this pipeline must not have.
bun -e "const fs=require('node:fs'); const fail=(m)=>{console.error(m);process.exit(1)}; const d=Bun.YAML.parse(fs.readFileSync('.github/workflows/release.yml','utf8')); const runs=d.jobs.publish.steps.filter((s)=>s.run); if (runs.length!==8) fail('expected 8 run blocks, got '+runs.length); d.jobs.publish.steps.forEach((s,i)=>{ if (s.run) { const f='/tmp/release-run-'+i+'.sh'; fs.writeFileSync(f, s.run); if (fs.statSync(f).size===0) fail('empty run block: '+f); } }); console.log('extracted', runs.length, 'run blocks')"
for f in /tmp/release-run-*.sh; do bash -n "$f" || exit 1; done && echo "bash -n: ok"
```

Expected: `yaml parses; steps: 11`, a clean typecheck, `extracted 8 run blocks`, and `bash -n: ok`. The step count is what catches a step silently disappearing during an edit; the name list is what catches a reorder.

- [ ] **Step 3: Verify the fail-fast ordering is intact, on the file itself**

```bash
grep -n -E "^\s+- name:" .github/workflows/release.yml
```

Expected order: `Verify tag…` → `Setup Bun` → `Extract release notes…` → `Install dependencies` → `Typecheck + tests` → `Setup Node…` → `Bump npm…` → `Publish to npm…` → `Verify the packed tarball…` → `Publish the GitHub Release`. The extraction step must appear **before** `Publish to npm`, and `Publish the GitHub Release` **after** it.

- [ ] **Step 4: Rehearse the compare-link derivation with synthetic tag lists**

```bash
derive() { printf '%s\n' "$2" | sed 's|.*refs/tags/||; s|\^{}||' | sort -u -V \
  | awk -v cur="v$1" '$0 == cur { exit } { last = $0 } END { print last }'; }
TAGS='refs/tags/v0.1.1
refs/tags/v0.1.1^{}
refs/tags/v0.1.3
refs/tags/v0.1.3^{}'
echo "[$(derive 0.1.3 "$TAGS")]"   # -> [v0.1.1]
echo "[$(derive 0.1.1 "$TAGS")]"   # -> []           (first release: no compare line)
PREFIX='refs/tags/v0.1.3
refs/tags/v0.1.30'
echo "[$(derive 0.1.30 "$PREFIX")]"  # -> [v0.1.3]   (prefix collision handled)
```

Expected: exactly the three bracketed results above. An empty result must lead to no `**Full Changelog**` line, not to an empty link.

- [ ] **Step 5: Rehearse the identity gate locally against the v0.1.3 tree**

```bash
rm -rf /tmp/plan-gate && mkdir -p /tmp/plan-gate
git archive v0.1.3 | tar -x -C /tmp/plan-gate
cd /tmp/plan-gate
TGZ="$(npm pack --silent | tail -1)"
echo "packed: $TGZ"
case "$TGZ" in pi-voicekit-*.tgz) echo "filename ok";; *) echo "unexpected"; exit 1;; esac
LOCAL="$(sha1sum "$TGZ" | cut -d' ' -f1)"
REMOTE="$(npm view pi-voicekit@0.1.3 dist.shasum)"
echo "local=$LOCAL remote=$REMOTE"
[ "$LOCAL" = "$REMOTE" ] && echo "gate would pass"
```

Expected: `pi-voicekit-0.1.3.tgz sha1 3eea444894dafd6b60f92b582670db368b6d3b1b matches the registry` and exit `0`
(the packing itself is offline; `npm view` needs the network).

Then prove the gate can also **fail**, by running that same block — extracted from the workflow, not
retyped — against a stubbed `npm`. Two negatives: a registry that disagrees, and an `npm pack` whose
output is not a tarball name.

```bash
cd "$(git -C /home/feng/workspace/pi-voicekit rev-parse --show-toplevel)"   # the new workflow lives here
bun -e "const fs=require('node:fs'); const fail=(m)=>{console.error(m);process.exit(1)}; const d=Bun.YAML.parse(fs.readFileSync('.github/workflows/release.yml','utf8')); const step=d.jobs.publish.steps.find((s)=>(s.name||'').startsWith('Verify the packed')); if (!step) fail('step not found: Verify the packed'); fs.writeFileSync('/tmp/gate.sh', step.run); console.log('extracted the identity gate:', step.run.split('\n').length, 'lines')"

REAL_NPM="$(command -v npm)"; export REAL_NPM
mkdir -p /tmp/plan-stub-npm && cat > /tmp/plan-stub-npm/npm <<'NPMSTUB'
#!/usr/bin/env bash
if [ "$1" = "view" ]; then echo "0000000000000000000000000000000000000000"; exit 0; fi
exec "$REAL_NPM" "$@"
NPMSTUB
chmod +x /tmp/plan-stub-npm/npm

mkdir -p /tmp/plan-stub-badpack && printf '#!/usr/bin/env bash\necho "npm notice something"\necho "not-a-tarball.txt"\n' > /tmp/plan-stub-badpack/npm
chmod +x /tmp/plan-stub-badpack/npm

cd /tmp/plan-gate
for PATH_DIR in /tmp/plan-stub-npm /tmp/plan-stub-badpack; do
  printf '  [%s] ' "$PATH_DIR"
  if VERSION=0.1.3 GITHUB_ENV=/tmp/ghenv PATH="$PATH_DIR:$PATH" bash /tmp/gate.sh; then echo rc=0; else echo "rc=$?"; fi
done
rm -rf /tmp/plan-gate /tmp/plan-stub-npm /tmp/plan-stub-badpack /tmp/gate.sh
```

Expected: the first stub exits `1` reporting the packed sha1 differs from the published one; the second
exits `1` on the unexpected `npm pack` output. Both were measured. This is Review Focus item 5, and it is
the gate that stops a wrong tarball from ever reaching a Release.

- [ ] **Step 6: Rehearse the release-state guard against a stubbed `gh`**

This guard is the only pipeline logic a local test can exercise before Task 5, and it is where a
mistake publishes the wrong thing instead of failing. Run it five ways against a fake `gh` on `PATH`:

```bash
mkdir -p /tmp/plan-stub && cat > /tmp/plan-stub/gh <<'STUB'
#!/usr/bin/env bash
echo "gh $*" >> "$STUB_LOG"
if [ "$1 $2" = "release view" ]; then
  case "$STUB_MODE" in
    absent) echo "release not found" >&2; exit 1;;
    apifail) echo "HTTP 502: bad gateway" >&2; exit 1;;
    published|draft|draft_no_asset)
      case "$*" in
        *isDraft*) [ "$STUB_MODE" = published ] && echo false || echo true; exit 0;;
        *assets*)  [ "$STUB_MODE" = draft_no_asset ] && exit 0 || echo "pi-voicekit-0.1.4.tgz"; exit 0;;
        *) echo "Title: v0.1.4"; exit 0;;
      esac;;
  esac
fi
case "$1 $2" in "release create"|"release edit"|"release upload") echo "ok: $1 $2"; exit 0;; esac
echo "unhandled: $*" >&2; exit 2
STUB
chmod +x /tmp/plan-stub/gh

# the guard block itself, taken straight out of the workflow — not a hand-kept copy
bun -e "const fs=require('node:fs'); const fail=(m)=>{console.error(m);process.exit(1)}; const d=Bun.YAML.parse(fs.readFileSync('.github/workflows/release.yml','utf8')); const last=d.jobs.publish.steps.at(-1); if (!last?.run || !(last.name||'').startsWith('Publish the GitHub Release')) fail('last step is not the release step: '+(last?.name||last?.uses)); fs.writeFileSync('/tmp/plan-guard.sh', last.run); console.log('extracted the release guard:', last.run.split('\n').length, 'lines')"
echo hi > /tmp/release-notes.md

for mode in absent published draft draft_no_asset apifail; do
  printf "  [%-14s] " "$mode"
  if STUB_MODE=$mode STUB_LOG=/tmp/gh-$mode.log PATH=/tmp/plan-stub:$PATH \
     VERSION=0.1.4 TGZ=pi-voicekit-0.1.4.tgz RUNNER_TEMP=/tmp bash /tmp/plan-guard.sh; then
    echo "rc=0"
  else
    echo "rc=$?"
  fi
  sed 's/^/      /' "/tmp/gh-$mode.log"
done
```

Expected, mode by mode — this table is the point of the step:

| mode | exit | calls it must make |
| --- | --- | --- |
| `absent` | 0 | `view --json isDraft` → `create --draft` → `edit --draft=false` |
| `published` | 0 | `view --json isDraft` only, then "already published — nothing to do" |
| `draft` | 0 | `view --json isDraft` → `upload --clobber` → `edit` (re-uploaded even though a same-named asset exists) |
| `draft_no_asset` | 0 | identical to `draft` — the guard no longer reads the asset list at all |
| `apifail` | 1 | `view --json isDraft` only, then `::error::cannot determine the state of v0.1.4` |

Both `draft` rows are why the guard re-uploads unconditionally: a name-only check was **measured** to
accept a same-named 4096-byte junk asset, and `--clobber` was measured to replace it with the verified
bytes (Task 5 Step 1 rehearses exactly that against the real API).

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): generate the GitHub Release from the changelog section"
```

---

### Task 3: Release policy in CONTRIBUTING.md, and retiring the local publish script

**Files:**
- Modify: `CONTRIBUTING.md` (table of contents, plus a new `## Release` section between `## Pull Request Process` and `## Coding Standards`)
- Modify: `package.json` (`scripts.release`)

**Interfaces:**
- Consumes: nothing at runtime.
- Produces: the human procedure Task 5 follows — the one-commit release convention the workflow's fail-fast gate depends on.

- [ ] **Step 1: Add the section to the table of contents**

In `CONTRIBUTING.md`, add one line after `- [Pull Request Process](#pull-request-process)`:

```markdown
- [Release](#release)
```

- [ ] **Step 2: Add the `## Release` section**

Insert between the end of `## Pull Request Process` and the start of `## Coding Standards`:

```markdown
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
```

- [ ] **Step 3: Remove the local publish script**

In `package.json`, delete exactly this line from `scripts` (leave `release:dry`):

```json
    "release": "bun run check && bun publish --access public"
```

- [ ] **Step 4: Verify**

```bash
bun run check
bun run format:check
node -e "const s=require('./package.json').scripts; if(s.release) throw new Error('release script still present'); if(!s['release:dry']) throw new Error('release:dry was removed by mistake'); console.log('scripts ok')"
grep -n "^## Release" CONTRIBUTING.md
grep -n "^- \[Release\]" CONTRIBUTING.md
```

Expected: gate and format check pass; the `release` script is gone and `release:dry` remains; both CONTRIBUTING markers found.

- [ ] **Step 5: Commit**

```bash
git add CONTRIBUTING.md package.json
git commit -m "docs: document the release procedure and drop the local publish script"
```

---

### Task 4: Backfill the changelog's version links (independent, optional)

**Files:**
- Modify: `CHANGELOG.md` (the link-definition block at the bottom)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing the pipeline depends on — it only makes the 0.1.x versions linkable, which the file already promises by declaring Keep a Changelog.

- [ ] **Step 1: Insert the missing definitions**

At the **top** of the existing definition block at the bottom of `CHANGELOG.md` (the block that currently starts with the upstream `codexstar69/pi-listen` links), insert:

```markdown
[Unreleased]: https://github.com/CyFeng16/pi-voicekit/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/CyFeng16/pi-voicekit/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/CyFeng16/pi-voicekit/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/CyFeng16/pi-voicekit/releases/tag/v0.1.1
```

`[0.1.0]` deliberately gets no definition: 0.1.0 was published to npm but never tagged in git
(`git ls-remote --tags origin` lists v0.1.1 and up) and its registry entry carries no `gitHead`, so
there is no commit or tag to point at. A definition that 404s is worse than none — the heading then
renders as the plain text `[0.1.0]`, exactly as the upstream-era sections already do.

Every release after this one repeats the chore: the `[Unreleased]` definition moves to
`compare/vX.Y.Z...HEAD` and the released version gets its own line, in the same release commit —
CONTRIBUTING's release steps (Task 3 Step 2) carry it. Nothing gates it, which is exactly why it belongs
in the written procedure rather than in someone's memory.

- [ ] **Step 2: Verify no definition shadows another, and the labels all resolve**

```bash
grep -n -E "^\[(Unreleased|0\.1\.[0-9])\]" CHANGELOG.md
node - <<'EOF'
const fs = require("node:fs");
const md = fs.readFileSync("CHANGELOG.md", "utf8");
for (const v of ["Unreleased", "0.1.3", "0.1.2", "0.1.1"]) {
	if (!md.includes(`[${v}]: `)) throw new Error(`missing definition for ${v}`);
}
const defined = (md.match(/^\[[^\]]+\]: /gm) || []).length;
const labels = new Set((md.match(/^\[[^\]]+\]: /gm) || []).map((l) => l.trim()));
if (labels.size !== defined) throw new Error("duplicate definition label");
console.log("definitions ok:", defined);
EOF
# A definition that 404s is worse than none, so check the links instead of assuming them.
grep -oE '^\[(Unreleased|0\.1\.[0-9])\]: \S+' CHANGELOG.md | awk '{print $2}' | while read -r url; do
  printf "  %s %s\n" "$(curl -s -o /dev/null -w '%{http_code}' -L "$url")" "$url"
done
```

Expected: four new definitions listed, no duplicate-label error, the count printed, and **every link
returning `200`** (measured: the two compare links and `releases/tag/v0.1.1` all return 200;
`releases/tag/v0.1.0` returns 404, which is why it is not in the list).

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): link the 0.1.x versions instead of leaving them unanchored"
```

---

### Task 5: The acceptance release (human-driven, once)

**Authorization gate — do not start this task without it.** Everything above produces artifacts; this
task publishes. It pushes to `main`, pushes a tag, publishes to npm and opens a GitHub Release, and
none of that is implied by approving this plan. Ask for it explicitly, and run it while the
maintainer is watching.

**Files:**
- Modify: `package.json`, `package-lock.json`, `CHANGELOG.md` — the one release commit
- External: the pushed tag, the npm registry entry, the GitHub Release

**Interfaces:**
- Consumes: Tasks 1–3 (the workflow and the documented procedure) and the maintainer's decision on **which version** this release is.
- Produces: the first real release that satisfies every invariant — and the only verification that cannot be replaced by a mock.

- [ ] **Step 1: Rehearse the draft-recovery path against the real API (publishes nothing)**

Do this **before** cutting the release: it is the one branch of the guard that only a real GitHub can
exercise, and the branch where a defect was actually measured. Measured while this plan was written — a
4096-byte junk file carrying the tarball's name **did** satisfy the old name-only check (that guard would
have published 4 096 bytes as the release asset), and `gh release upload --clobber` replaced it with the
verified bytes: 4 096 → 174 100, and the downloaded file hashed to `3eea444894…`, the registry's
`dist.shasum`. A zero-byte upload is impossible (the API answers `HTTP 400: Bad Content-Length`), so use
a junk file with real bytes. A draft never creates the git tag, so the tag list must be unchanged
afterwards.

```bash
TAG="v0.0.0-draft-rehearsal"; REPO=CyFeng16/pi-voicekit
rm -rf /tmp/draft-rehearsal && mkdir -p /tmp/draft-rehearsal && cd /tmp/draft-rehearsal
git -C /home/feng/workspace/pi-voicekit archive v0.1.3 | tar -x -C .
TGZ="$(npm pack --silent | tail -1)"                       # the real bytes, name included
sha1sum "$TGZ"                                             # must equal npm view pi-voicekit@0.1.3 dist.shasum
mv "$TGZ" real.tgz && head -c 4096 /dev/urandom > "$TGZ"   # same name, wrong bytes

gh release create "$TAG" --repo $REPO --draft --title "draft-rehearsal (temporary)" \
  --notes "temporary; created to rehearse the release guard" "$TGZ"
gh release view "$TAG" --repo $REPO --json assets --jq '[.assets[] | {name,size,state}]'
#   -> [{"name":"pi-voicekit-0.1.3.tgz","size":4096,"state":"uploaded"}]

cp real.tgz "$TGZ"                                        # the guard's refill, verbatim
gh release upload "$TAG" "$TGZ" --repo $REPO --clobber
gh release view "$TAG" --repo $REPO --json assets --jq '[.assets[] | {name,size,state}]'
#   -> [{"name":"pi-voicekit-0.1.3.tgz","size":174100,"state":"uploaded"}]
rm -rf dl && mkdir dl && gh release download "$TAG" --repo $REPO --pattern '*.tgz' --dir dl
sha1sum dl/"$TGZ"                                          # must equal the registry's dist.shasum

gh release delete "$TAG" --repo $REPO --yes --cleanup-tag  # a 422 about the tag is expected: drafts have none
gh release list --repo $REPO                               # must not mention $TAG
git -C /home/feng/workspace/pi-voicekit ls-remote --tags origin | sed 's|.*refs/tags/||' | sort -u
```

Expected: 4 096 → the real size, a sha1 equal to the registry's, an empty Release list and an unchanged
tag list (v0.1.1–v0.1.3). If `--clobber` does **not** replace the junk asset, stop: the guard's draft
branch is not safe, and the fallback is deleting the offending asset (`gh release delete-asset`) before
re-uploading.

- [ ] **Step 2: Decide the version, then cut the release commit**

Input required: the version to release (the plan deliberately does not fix it; the spec records the decision point here). Then:

```bash
# replace X.Y.Z below. npm bumps package.json plus exactly the two root version
# fields of package-lock.json. Never hand-edit those versions: 183 entries in that
# file look like `"version": "x.y.z"` and only two of them belong to this package.
npm version X.Y.Z --no-git-tag-version
node -e "const l=require('./package-lock.json');console.log('package.json',require('./package.json').version,'| lock root',l.version,'| prettier stays',l.packages['node_modules/prettier'].version)"
```

Then edit `CHANGELOG.md` by hand: move the `[Unreleased]` content into `## [X.Y.Z] - <today>`, and leave `[Unreleased]` empty. Then verify, and commit as `chore: release X.Y.Z` with exactly those files staged:

```bash
bun run check && bun run format:check   # format:check covers package.json and package-lock.json
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: release X.Y.Z"
git push origin main
git tag vX.Y.Z && git push origin vX.Y.Z
```

- [ ] **Step 3: Watch the run and assert the four consumer-visible facts**

```bash
SHA="$(git rev-parse HEAD)"   # the release commit you just tagged
gh run list --repo CyFeng16/pi-voicekit --workflow release.yml --commit "$SHA" \
  --json databaseId,status,conclusion,url
gh run watch "$(gh run list --repo CyFeng16/pi-voicekit --workflow release.yml --commit "$SHA" \
  --json databaseId --jq '.[0].databaseId')" --repo CyFeng16/pi-voicekit

gh release view "vX.Y.Z" --repo CyFeng16/pi-voicekit --json isDraft,body,assets \
  --jq '{isDraft, body, assets: [.assets[].name]}'
npm view pi-voicekit@X.Y.Z dist.shasum dist.integrity dist.attestations

# hash what GitHub actually serves, not what the registry claims
rm -rf /tmp/rel && mkdir -p /tmp/rel
gh release download "vX.Y.Z" --repo CyFeng16/pi-voicekit --pattern '*.tgz' --dir /tmp/rel
sha1sum /tmp/rel/pi-voicekit-X.Y.Z.tgz
```

Assert, in order:
1. the run is `success` and the release is **not** a draft;
2. the release **body** equals the `CHANGELOG.md` section for this version plus the appended `**Full Changelog**` line;
3. the release **assets** contain `pi-voicekit-X.Y.Z.tgz`, and the sha1 of the file downloaded **from
   the Release** equals the registry's `dist.shasum`;
4. `Source code (zip)` / `Source code (tar.gz)` are present (GitHub adds them);
5. the version carries provenance: `npm view pi-voicekit@X.Y.Z dist.attestations` gives the bundle URL
   (the field itself holds only `url` + `predicateType` — measured), and fetching that URL yields the
   statement naming this repository and `.github/workflows/release.yml`. Measured on 0.1.3: two
   attestations (`.../npm/attestation/.../publish/v0.1` and `https://slsa.dev/provenance/v1`), the SLSA
   predicate carrying `ref: refs/tags/v0.1.3` and `path: .github/workflows/release.yml`;
   `gh attestation verify /tmp/rel/pi-voicekit-X.Y.Z.tgz --repo CyFeng16/pi-voicekit` does it in one step
   but needs gh ≥ 2.49 (this machine has 2.45.0).

- [ ] **Step 4: Assert the recovery path is real**

Re-run the same workflow from the Actions UI (or `gh run rerun <id>`), then confirm it reports `release vX.Y.Z already published — nothing to do`, that the npm publish step logs `already on the registry — skipping publish`, and that the release is unchanged. This is the invariant-5 check that no local test can perform.

- [ ] **Step 5: Record the outcome**

Reply to the plan with the run URL, the release URL, the observed sha1, and any divergence. If step 2 or 3 fails, **do not** hide it: attach the failing step's log to the spec's appendix and treat the pipeline as unverified.

---

## Plan self-review notes

- **Spec coverage:** §3.1 (release commit) → Task 3 Steps 1–2 and Task 5 Step 2; §4.1 steps 1–9 → Task 2 Step 1 (with the ordering assertion in Step 3); §4.2 script + 13 test cases → Task 1; §4.3 body → Task 2 Step 1 (extraction step) and Step 4; §4.4 assets + gate → Task 2 Steps 1 and 5; §4.5 permissions/token → Task 2 Step 1; §4.6 recovery, including the leftover-draft refill → Task 2 Step 1 (guard), Task 2 Step 6 (stub) and Task 5 Step 1 (real API), plus Task 5 Step 4 for the re-run assertion; §5.1 CONTRIBUTING → Task 3; §5.2 changelog links → Task 4; §5.3 `release` script → Task 3 Step 3; §6 verification plan → Tasks 1–2 and 5; §7 non-goals → Global Constraints. §5.4/§5.5 were already executed before this plan and need no task.
- **Deviation, deliberate:** the spec lists extraction (step 4) and the compare link (step 4b) as two items; the plan folds them into one workflow step because they share a file and no state. The observable result is identical.
- **Placeholder scan:** none. No `TBD`/`TODO`/"add error handling"/"similar to Task N"; the only bracketed token is `X.Y.Z` in Task 5, which is an input the maintainer supplies at the decision point the spec records — not a deferred detail.
- **Type consistency:** `normalizeVersion` / `extractEntry` and the `{status: "ok" | "missing" | "empty"}` result shape are used identically in the tests, the CLI and the workflow; `VERSION`, `TGZ` and `$RUNNER_TEMP/release-notes.md` keep the same names in every task that touches them.
- **Defect caught by this self-review:** Task 5 originally bumped the lockfile by rewriting `"version": "…"` entries in `package-lock.json`. Measured on a copy of the repository, that pattern matches **183** entries of which only **2** are this package's — it would have rewritten every dependency version. Replaced with `npm version X.Y.Z --no-git-tag-version`, verified on a throwaway clone: `package.json` plus exactly 2 root fields change, `node_modules/prettier` stays `3.3.3`, `bun.lock` is untouched, and only the two expected files show as modified.
- **Review round before hand-off** (independent, stronger model; every point re-checked against the repo rather than accepted on authority). Closed here: strict CLI argument validation plus real subprocess exit-code tests (the first version quietly accepted `--bogus` and extra positionals); the "every section is non-empty" assertion, which the release commit itself would have broken by emptying `[Unreleased]`; a draft-recovery hole where a **name-only asset check** accepted a same-named junk asset — measured against the real API at 4 096 bytes, with `--clobber` measured to replace it, so the guard now re-uploads the verified tarball unconditionally; the step count (11, not 10) and per-step `bash -n` from the parsed YAML instead of one concatenated blob; a stubbed-`gh` rehearsal of all five release states; and the `v0.1.0` link that 404s. Also folded in: `npm version X.Y.Z --no-git-tag-version`, CONTRIBUTING's failure-recovery table, and the changelog link chore.
- **Two spec gaps this review exposed, now closed on both sides:** §4.6 did not cover a draft left with a broken asset by a failed upload, and its step-9 guard read any failed `gh release view` as "absent". The plan's guard re-uploads unconditionally (`--clobber`) and matches `not found` before treating a release as absent; the spec's step-9 sketch, §4.1's item 9 and §4.6's recovery row now say the same. §4.5's claim that deferring `GH_TOKEN` "denies the token" to install and test was softened to what it is — a smaller surface, not isolation, since a step can persist a directory through `$GITHUB_PATH`.
