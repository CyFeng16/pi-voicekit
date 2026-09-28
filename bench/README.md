# Benchmark slices

This directory defines the speech corpora this project is measured on. It holds **no audio**: the
slices are fetched on demand into `bench/data/`, which is git-ignored and never published. What is
tracked here is the definition — which dataset, at which revision, which rows, under which licence —
so the benchmark is reproducible and a checkout stays small.

Scope: the supported languages only, **Chinese, English and mixed Chinese–English** (see the
[language scope](../README.md#language-scope) in the README). Every measurement in
[`docs/BENCHMARKS.md`](../docs/BENCHMARKS.md) comes from these slices.

| File             | Tracked | Purpose                                                                     |
| ---------------- | ------- | --------------------------------------------------------------------------- |
| `manifest.jsonl` | yes     | One JSON object per slice: dataset, pinned revision, selection, licence     |
| `fetch.py`       | yes     | Deterministic fetcher — writes `bench/data/<slice>/` with a sha256 per file |
| `data/`          | **no**  | The audio and its per-slice manifest (git-ignored)                          |

## Fetching

`fetch.py` carries a [PEP 723](https://peps.python.org/pep-0723/) dependency block, so uv provisions
`datasets` and `huggingface_hub` itself — nothing is added to this repository or to your environment:

```bash
uv run bench/fetch.py                      # every slice
uv run bench/fetch.py --only fleurs-zh     # one slice
uv run bench/fetch.py --out /tmp/bench-data
```

Audio is read with `decode=False`, so no ffmpeg is involved and the source wav bytes are written
unchanged. Each row records `sha256`, `bytes`, the dataset revision and the licence in
`bench/data/<slice>/manifest.jsonl`.

## The frozen corpus

Five slices, 70 utterances: 28 Chinese, 28 English, 14 mixed. This is the corpus behind the
published recognition, segmentation and punctuation numbers, and fetching it reproduces it exactly —
the 14 `fleurs-zh` references came back byte-identical to the corpus the published numbers were
measured on (verified 2026-09-28).

| Slice          | Rows | Language | Source                                                                               | Licence      |
| -------------- | ---- | -------- | ------------------------------------------------------------------------------------ | ------------ |
| `fleurs-zh`    | 14   | zh       | [google/fleurs](https://huggingface.co/datasets/google/fleurs) `cmn_hans_cn`, `test` | CC-BY-4.0    |
| `fleurs-en`    | 14   | en       | [google/fleurs](https://huggingface.co/datasets/google/fleurs) `en_us`, `test`       | CC-BY-4.0    |
| `ascend-zh`    | 14   | zh       | [CAiRE/ASCEND](https://huggingface.co/datasets/CAiRE/ASCEND) `train`                 | CC-BY-SA-4.0 |
| `ascend-en`    | 14   | en       | [CAiRE/ASCEND](https://huggingface.co/datasets/CAiRE/ASCEND) `train`                 | CC-BY-SA-4.0 |
| `ascend-mixed` | 14   | mixed    | [CAiRE/ASCEND](https://huggingface.co/datasets/CAiRE/ASCEND) `train`                 | CC-BY-SA-4.0 |

The read slices are read speech; the ASCEND slices are spontaneous and carry the code switching this
project targets. Two reference rules apply, named per slice in the manifest:
`drop-spaces-between-cjk` removes the spaces FLEURS puts between hanzi without touching the spaces
that separate Chinese from Latin text, and `as-shipped` keeps the dataset's text unchanged.

## Why the data is not in the repository

- **Licences.** Four of the five slices are CC-BY-4.0 or CC-BY-SA-4.0, which permit redistribution but
  require attribution and — for CC-BY-SA — share-alike terms that a MIT-licensed extension must not
  silently absorb. Fetching keeps the obligation with the user, where the source's own terms apply.
- **Size.** The 70-utterance slices are ~35 MB; the meeting corpora used for one-off experiments are
  several gigabytes.
- **Reach.** This repository is a published npm package. `package.json` whitelists exactly
  `extensions`, `README.md`, `LICENSE` and `package.json`, and
  [`tests/publish-surface.test.ts`](../tests/publish-surface.test.ts) asserts that whitelist and the
  manifest's own contract (every slice pins a 40-character revision and a licence), so a corpus file
  cannot reach the tarball by accident.

## Adding a slice

1. Verify the dataset's licence and that it is not gated for the account that will fetch it.
2. Pin the dataset revision: `curl -s https://huggingface.co/api/datasets/<id> | jq -r .sha`.
3. Add one line to `manifest.jsonl` with `id`, `layer`, `language`, `dataset`, `config`, `split`,
   `revision`, `license`, `source`, `select`, `audioColumn`, `textColumns` and `referenceRule`.
4. Run `uv run bench/fetch.py --only <id>` and record the printed digest.
5. If the slice is meant to be the default for a language, say so in `docs/BENCHMARKS.md`.

Layers are `standard` (comparable to published results), `product` (the maintainer's own dictation,
not distributable) and `smoke` (a few seconds, licence-clean, small enough for CI).

## Candidate slices, not wired in yet

Verified licences, listed so the next slice does not start from scratch:

| Source                                                                             | Language | Licence         | Note                                                                 |
| ---------------------------------------------------------------------------------- | -------- | --------------- | -------------------------------------------------------------------- |
| [AISHELL/AISHELL-1](https://huggingface.co/datasets/AISHELL/AISHELL-1)             | zh       | Apache-2.0      | Read Mandarin; the standard Chinese benchmark quoted in papers       |
| [AISHELL/AISHELL-4](https://huggingface.co/datasets/AISHELL/AISHELL-4)             | zh       | Apache-2.0      | Meeting speech; the source of the earlier segmentation experiments   |
| [openslr/librispeech_asr](https://huggingface.co/datasets/openslr/librispeech_asr) | en       | CC-BY-4.0       | `test.clean` / `test.other`; the English baseline everyone quotes    |
| [BAAI/CS-Dialogue](https://huggingface.co/datasets/BAAI/CS-Dialogue)               | mixed    | CC-BY-NC-SA-4.0 | 104 h spontaneous code switching, **non-commercial** — research only |
| WenetSpeech                                                                        | zh       | not verified    | `test_net` / `test_meeting` are the usual real-world proxies         |
