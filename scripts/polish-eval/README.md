# Transcript post-processing evaluation

The acceptance protocol for the post-processing pass, runnable without a human in
the loop for everything except the recording itself.

The pass is text in, text out, so the whole measurement can run offline: build a
corpus of `(raw transcript, ground truth)` pairs, run the real prompt through the
real pass, and score the results against the reference. Nothing here needs a
microphone, a terminal, or the Pi runtime.

## Quick start

```bash
# 1. build a synthetic corpus from the seed sentences (no network, no audio)
bun run scripts/polish-eval/cli.ts synth --out /tmp/corpus.jsonl

# 2. prove the harness itself works: `oracle` answers with the ground truth
bun run scripts/polish-eval/cli.ts run --corpus /tmp/corpus.jsonl --caller oracle --out /tmp/oracle

# 3. see what a pass that changes nothing scores (it fails the meaning gate, by design)
bun run scripts/polish-eval/cli.ts run --corpus /tmp/corpus.jsonl --caller fake --out /tmp/noop

# 4. real numbers: an OpenAI-compatible endpoint, explicitly allowed to call out
POLISH_EVAL_BASE_URL=https://example.invalid/v1 \
POLISH_EVAL_API_KEY=... POLISH_EVAL_MODEL=... \
bun run scripts/polish-eval/cli.ts run --corpus /tmp/corpus.jsonl --caller openai --allow-network
```

Each `run` writes `report.md` and `run.json` into its output directory and exits
non-zero when a gate fails.

## Commands

| Command | What it does |
| ------- | ------------ |
| `synth --seeds <file> [--seed N] [--out <file>]` | Inject recogniser-style errors into the seed sentences and write a corpus |
| `script --seeds <file> [--skeleton]` | Print the script to read aloud, or a fill-in JSONL skeleton for a recorded corpus |
| `ingest --seeds <file> --raw <file> --backend <name> [--out <file>]` | Pair recorded raw transcripts with the seeds' ground truth |
| `run --corpus <file> [options]` | Run the pass over the corpus and score it |
| `compare --report <a.json> --against <b.json>` | Compare two runs, refusing to compare different configurations |

`run` options: `--caller fake|oracle|openai`, `--arms no-context,last-2-turns,summary-only`,
`--turns N`, `--timeout-ms N`, `--out <dir>`, `--full`, `--base-url URL`, `--model NAME`,
`--allow-network`.

## Corpus

JSON Lines, one dictation per line. The corpus is deliberately **not** stored in
this repository: a corpus recorded from real dictation contains whatever the
speaker said. The default location is `~/.pi/voicekit-eval/corpus.jsonl`.

```json
{"id":"t4","category":"zh-en-switch","backend":"local",
 "raw":"先看 axe eos 的 time out",
 "groundTruth":"先看 axios 的 timeout",
 "context":[{"role":"user","text":"我们把请求库换成 axios 了"}],
 "summary":"Earlier: 请求库从 fetch 换成 axios"}
```

`raw` and `groundTruth` are required; `context` (oldest first) and `summary` give
the context arms something to measure. `backend` names the recogniser; a corpus
that mixes two of them is refused, because the protocol is reported per backend and
never pooled. `synthetic` marks an injected sample.

## Callers

- **`fake`** — deterministic, offline, returns the transcript unchanged. Use it to
  check the plumbing and to see a failing meaning gate.
- **`oracle`** — answers with the corpus ground truth. A **self-check of the
  harness**, never a measurement of the pass: if a perfect answer does not score a
  positive gain and zero flags, the scorer is wrong.
- **`openai`** — a real OpenAI-compatible chat endpoint, configured with
  `--base-url`/`--model` or `POLISH_EVAL_BASE_URL`/`POLISH_EVAL_API_KEY`/`POLISH_EVAL_MODEL`.
  Refused unless `--allow-network` is passed: the run costs money and sends
  transcript text to a provider. The key is only ever sent in an authorization
  header and never printed.

## Arms

Three arms run by default, because the design record requires a three-way contrast
before conversation context ships:

- `no-context` — turns set to zero, which suppresses the summary too.
- `last-2-turns` — the shipped default; conversation turns, never the digest.
- `summary-only` — the compaction digest alone.

Context ships only if the context arms are gain-neutral or better against
`no-context`.

## Reading the report

Gates first, then the numbers, then the queue of samples a human should look at.

| # | Gate | Fails when |
| - | ---- | ---------- |
| 1 | No sample loses or changes meaning | any sample trips a meaning flag (a number or identifier that was right and is now wrong, reference wording dropped, wording invented) |
| 2 | Fallback rate at most 20% | more than one sample in five did not apply (timeout, provider error, rejected output) |
| 3 | p95 latency over successful passes | no pass succeeded, so no latency can be reported |
| 4 | Reported per backend | never fails: a mixed corpus is refused before the run starts |
| 5 | Configuration recorded | comparing runs whose prompt, model, budget or timeout differ |

Latency is always reported over **successful** passes only, separately from the
fallback share: an all-fallback run must not look fast.

## What this does not prove

- **Synthetic errors are not real recognition errors.** The injector degrades text
  with its own tables, so a synthetic run measures the pass and the scorer, not the
  recogniser. Real numbers need a real corpus.
- **A script-read corpus is not spontaneous speech.** Reading a prepared script
  gives real voice, microphone and acoustic distribution, but no false starts,
  topic drifts or mid-sentence changes of mind that nobody rehearsed.
- **Meaning flags are heuristics.** They decide who to ask, not what is true. The
  spot-check queue exists because a person still signs off on gate 1.
- **The terminal-facing behaviour is out of scope here.** Editor ownership, cancel,
  branch navigation and the recording state machine are not exercised: this tool
  measures the pass, not the extension's event handling.

## Adding a case

Add a line to `seeds.jsonl` with a category, the text to be said, and optionally the
context it follows. The same file drives both the synthetic corpus and the reading
script, so a new case is covered on both paths at once.
