# Benchmarks

Measured performance of the local backend and the transcript polish pass that 0.3.x
shipped, with the protocol needed to read the numbers correctly. The polish pass was
removed in favour of the offline punctuation step; its tables below are kept as recorded
history, not as a description of the current code. The compact table a package user sees
is in the [README](../README.md); this is the deep version, and it lives on GitHub
because npm ships only the extension and the README.

**RTF (real-time factor) is processing time divided by audio duration.** Lower is
better: 0.1 means the work took one tenth of the audio's duration. A value below 1.0
is faster than real time; a value above 1.0 means the work did not keep up with the
speech.

## Measurement setup

- **Corpus** — 70 published utterances: 28 Chinese, 28 English, 14 mixed
  Chinese–English, stored as 16 kHz mono. The spontaneous speech and all 14 mixed
  utterances come from [ASCEND](https://huggingface.co/datasets/CAiRE/ASCEND)
  (spontaneous Mandarin, including Chinese–English code switching); the read Chinese
  and English come from [FLEURS](https://huggingface.co/datasets/google/fleurs), 14
  utterances each. Total audio: 181.6 s Chinese, 168.6 s English, 59.5 s mixed.
- **Recognition** — the local backend (`sherpa-onnx`) on CPU, no network. A time
  covers the decode call only; audio capture is not part of it.
- **Polish (removed feature)** — the evaluation harness's `openai` caller against a remote
  OpenAI-compatible endpoint, left unnamed here. That
  endpoint's latency varies run to run, so the polish numbers describe one measurement
  window, not a service guarantee.
- The corpus measurements were taken on 2026-09-26. The four dictations in the
  end-to-end table are real ones, as recorded by the polish audit entries.

## Hardware

Local recognition runs on the maintainer's machine: an **AMD Ryzen 9 7950X 16-Core
Processor** running **Ubuntu 24.04.5 LTS** (kernel `7.0.0-31-generic`). These are
single-machine numbers: the comparison between recognisers is what transfers, absolute
times depend on the CPU. The polish numbers (removed feature) move with the endpoint and the
network instead, not with this machine.

## Segmentation — how long a pause ends a segment

The local backend cuts long audio at pauses before decoding: a segment ends when the speaker
stops for `minSilenceDuration`, and no segment exceeds `maxSpeechDuration` (10 s). The pause is
the setting that matters, and 1 s ships as of 0.3.2.

**Protocol.** 12 audios of 60–92 s assembled at random from 42 Chinese and mixed-language
corpus clips (8–17 clips each, inter-clip gaps drawn from 200–900 ms so no single gap sits on a
threshold under test), decoded on CPU by two recognisers, with the harness's offline fake
caller (`--caller fake`, no network). Metric: raw character error rate of the transcript
against the concatenated reference — lower is better. 96/96 runs produced a result.

| Pause | paraformer-zh | sensevoice-small | Mean segments | Paired vs 0.25 s |
| --- | --- | --- | --- | --- |
| 0.25 s (old default) | 0.1439 | 0.1311 | 16.8 | — |
| 1 s (new default) | 0.1315 | 0.1095 | 8.4 | better 9/12, worse 1/12 |
| 0.8 s | 0.1392 | 0.1200 | 11.4 | better 5/12 and 9/12 |
| no segmentation | 0.1659 | 0.4130 | 1.0 | worse 10/12 for sensevoice |

Values are means over the 12 audios; the paired column counts audios where the setting beat
the old default on the same audio and recogniser.

**Reading.** Not segmenting is worse for both recognisers and catastrophic for sensevoice. 1 s
and 0.8 s are close, and 1 s produces about half the segments — half the downstream calls
in the pipeline the sweep measured — for the same or better accuracy. The old 0.25 s default
was the worst setting tried.

**Honest limits.** The audios are assembled from clips rather than natural continuous speech, so
they support relative comparisons but not absolute accuracy claims; only two recognisers were
measured, on CPU; and the polish side of the pipeline was not part of this comparison.

The harness that assembled these audios and swept the pause was removed from the repository
with the polish pass; the numbers above are kept as recorded history, not as a runnable
protocol.

## Recognition — local CPU, no network

The same 70 utterances were decoded by each recogniser, so the rows compare directly.
"Audio (s)" is the duration of that language's utterances, "Decode (s)" the sum of
recognition time over them, RTF decode over audio, and "Characters/s" the range of
output characters per second of decode time across the three languages.

| Recogniser       | Language    | Utterances | Audio (s) | Decode (s) | RTF   | Characters/s |
| ---------------- | ----------- | ---------- | --------- | ---------- | ----- | ------------ |
| paraformer-zh    | Chinese     | 28         | 181.6     | 2.5        | 0.014 | 247–983      |
| paraformer-zh    | English     | 28         | 168.6     | 2.2        | 0.013 | 247–983      |
| paraformer-zh    | Mixed zh–en | 14         | 59.5      | 1.0        | 0.016 | 247–983      |
| sensevoice-small | Chinese     | 28         | 181.6     | 5.0        | 0.028 | 134–451      |
| sensevoice-small | English     | 28         | 168.6     | 4.9        | 0.029 | 134–451      |
| sensevoice-small | Mixed zh–en | 14         | 59.5      | 2.4        | 0.040 | 134–451      |
| whisper-turbo    | Chinese     | 28         | 181.6     | 67.6       | 0.372 | 7–27         |
| whisper-turbo    | English     | 28         | 168.6     | 62.3       | 0.369 | 7–27         |
| whisper-turbo    | Mixed zh–en | 14         | 59.5      | 23.5       | 0.395 | 7–27         |

All three ran faster than real time. `paraformer-zh` is the Chinese-first model of the
three; its English and mixed rows were measured on the same corpus for completeness.

## Offline punctuation — the shipped step

The step that replaced the polish pass is local and deterministic: a sherpa-onnx CT-Transformer
model (`punct-ct-transformer-zh-en`, ~285 MB) runs in process and can only insert marks. Measured
on the maintainer's machine with local probes outside this repository (single-purpose scripts,
not shipped tooling), 4 threads, CPU:

| Measurement | Value |
| --- | --- |
| Chinese punctuation F1 | 0.000 → 0.811 on 70 uttered samples with punctuated references |
| English punctuation F1 | 0.000 → 0.175; the output is a Chinese full stop and no commas |
| Marks-only safety | 70/70 rows unchanged after stripping the mark set |
| Mixed Chinese + English terms | the model's raw output is **not** marks-only: `base_url` → `base _ url`, CJK-boundary spaces move, `可行，` → `可行，，` — which is why the shipped step splices the model's marks into the recogniser's own string and refuses any output that alters a non-mark character |
| Timing | one-time load 544 ms; `addPunct` p50 2.9 ms / p95 3.1 ms / max 3.4 ms on 27–32 character inputs |
| Reference punctuation density | AISHELL-4 reference transcripts measure 1 mark per 17.3 characters (11,139 marks / 192,491 characters); the step punctuates below 1 mark per 20 characters |

**Honest limits.** The probes live outside the repository and are not a runnable protocol: one
machine, four threads, one model revision, 70 utterances. The marks-only row is about the spliced
*step* on a corpus without spaced ASCII — the mixed-terms row is why the splice is mandatory.
English is skipped by the shipped rule rather than handled, so its 0.175 describes the model,
not a path a user can reach.

## Polish pass alone — single-call path (removed feature)

Kept as the recorded history of the deleted pass; it no longer describes anything the extension
does. This isolates the pass from the pipeline: one call per utterance, timed and scored over
the samples the pass actually applied. Fallbacks are excluded from the latency (a
latency over a failed call is not a latency) and reported separately; "Applied" is out
of 70 for sensevoice-small and whisper-turbo, and out of 28 for paraformer-zh. "Polish
(s)" is the sum of call latencies over the applied samples, RTF polish over audio, and
p50/p95 per-call latency over those same samples.

| Recogniser       | Language    | Applied | Audio (s) | Polish (s) | RTF   | p50 (ms) | p95 (ms) |
| ---------------- | ----------- | ------- | --------- | ---------- | ----- | -------- | -------- |
| sensevoice-small | Chinese     | 22      | 147.8     | 34.8       | 0.235 | 1125     | 5976     |
| sensevoice-small | English     | 17      | 92.9      | 16.2       | 0.175 | 676      | 4341     |
| sensevoice-small | Mixed zh–en | 11      | 39.4      | 11.5       | 0.291 | 552      | 4306     |
| whisper-turbo    | Chinese     | 17      | 77.7      | 25.9       | 0.333 | 795      | 7539     |
| whisper-turbo    | English     | 23      | 120.5     | 24.2       | 0.201 | 524      | 3381     |
| whisper-turbo    | Mixed zh–en | 13      | 50.1      | 14.9       | 0.297 | 879      | 3452     |
| paraformer-zh    | Chinese     | 25      | 153.5     | 25.1       | 0.164 | 509      | 3968     |

`paraformer-zh` has no English or mixed row here: that round used a Chinese-only
corpus, by design, so only the Chinese column was measured.

## End to end — segmented pipeline, local backend (removed feature)

What a dictation cost on the 0.3.x line: four real dictations through the then-shipped
segmented path, as recorded by the polish audit entries. "End to end" is recognition
plus polish; RTF is end to end over audio duration. Recognition is **derived** from the
0.023 recognition RTF measured for the local recogniser, not timed separately per
dictation — read the column as that measurement reproduced per dictation.

| Audio (s) | Recognition (s) | Polish (s) | End to end (s) | RTF   |
| --------- | --------------- | ---------- | -------------- | ----- |
| 24.7      | 0.57            | 2.27       | 2.84           | 0.115 |
| 28.0      | 0.64            | 2.34       | 2.98           | 0.107 |
| 8.1       | 0.19            | 0.375      | 0.56           | 0.069 |
| 9.7       | 0.22            | 1.254      | 1.48           | 0.152 |

### What this changed against the 0.2.x line

- **One slow polish call no longer costs the whole dictation.** On a degraded endpoint
  the 0.2.x single-call path fell back on 100% of a 79.6 s / 35-segment run, while the
  segmented pipeline polished 35 of 35 segments.
- **A dictation can come back partly polished instead of unpolished.** A segment that
  still fails after its retry keeps its own raw text while its neighbours keep their
  polished text.
- **A long dictation keeps its polish when one call is slow.** At most three segment calls
  are in flight and a timed-out segment is retried with thinking off, so a slow call costs
  one segment instead of the whole dictation - 35 of 35 segments against a degraded endpoint.
- **The numbers are auditable.** One audit entry per dictation records the recogniser
  and a segment summary — polished, kept raw, retried — so these claims can be checked
  locally.

## Accuracy context — the removed polish pass

Time is only half the picture. The same single-call measurement scores the deleted pass
against reference text: character error rate (CER) before and after polish, over applied
passes. Read this before reading the speed tables as "polish fixes recognition".

| Recogniser       | Corpus                              | CER before | CER after | Gain   |
| ---------------- | ----------------------------------- | ---------- | --------- | ------ |
| sensevoice-small | 70 utterances, zh + en + mixed      | 0.122      | 0.121     | +0.001 |
| paraformer-zh    | 28 Chinese utterances (zh-only run) | 0.075      | 0.095     | -0.020 |
| whisper-turbo    | 70 utterances, zh + en + mixed      | 0.423      | 0.413     | +0.010 |

Gain is the reference error rate before minus after, so positive means the text moved
closer to the reference. whisper-turbo's punctuation match fell from 0.696 to 0.463 at
the same time, so its small CER gain is not a quality win. On real recognition output
the gain is close to zero, and negative when the recogniser is already good
(`paraformer-zh`): treat the pass as formatting, reliability and punctuation rather
than general error correction.

## Reproducing

The harness that produced the polish numbers was removed from the repository together with
the polish pass, so those tables cannot be regenerated from a checkout: they are kept as the
recorded history of what was measured, not as a runnable protocol against the current code.

## Honest limits

- **The corpus is assembled from published recordings of read or spontaneous speech,
  not the maintainer's own microphone.**
- **Only 70 utterances**, so the accuracy differences are indicative, not precise.
- **Polish latency (removed feature) depends heavily on the remote endpoint and varies run
  to run.** The same corpus at the same configuration produced fallback rates between 7%
  and 29% for the single-call path on different runs.
- **The measured accuracy gain from the removed pass is close to zero on real recognition
  output, and can be slightly negative when the recogniser is already good.** Treat the
  pass as formatting, reliability and punctuation rather than as general error
  correction.
- **whisper-turbo is both the slowest and the least accurate of the three on this
  corpus, and its output lost words.** It is documented here, not recommended.
