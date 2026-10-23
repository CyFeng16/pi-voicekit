# pi-voicekit troubleshooting

## First things to check

Run these built-in commands inside Pi:

- `/voice test` — reports the audio tool it detected, whether the microphone actually produced audio, whether the sherpa-onnx runtime loaded, and the config in effect
- `/voice-settings` — the settings panel, where the model, language and scope live

If you only do one thing, start with `/voice test`.

## Symptom: "No audio capture tool found"

### What it means
None of `rec` (SoX), `ffmpeg` or `arecord` is on `PATH`, so there is nothing to record with.

### Fix
Install any one of them:

```sh
brew install sox          # macOS
sudo apt install sox      # Ubuntu/Debian
choco install sox         # Windows
```

`ffmpeg` and, on Linux, ALSA's `arecord` work just as well. Then restart Pi or run `/voice test`
again.

> When `PULSE_SERVER` is set (SSH audio tunnel / remote PulseAudio) capture prefers `ffmpeg`, because
> network Pulse sources do not work through SoX.

## Symptom: pi-voicekit says the platform is not supported

### What it means

The recogniser is a native addon (`sherpa-onnx-node`). It ships binaries for macOS and Linux on x64
and 64-bit ARM, and for Windows on x64 — but not for 32-bit ARM (`armv7l`), Windows on ARM64, or
Alpine's musl libc. On those targets recognition cannot run, and the message names the constraint:
`ARM32 (armv7l) is not supported by sherpa-onnx-node`, `Windows on ARM64 (win32/arm64) is not
supported …`, `Alpine Linux (musl libc) is not supported …`.

A missing module on a *supported* platform is a different failure — that message says the engine
could not be loaded and how to reinstall, because it is a broken install rather than a platform
limit.

### Fix

Move to a supported target: a glibc-based 64-bit distribution (or container), macOS on 64-bit ARM, or
Windows on x64. There is no cloud backend to switch to — 0.6.0 removed it — and none is planned.

## Symptom: pi exits with `symbol lookup error: … sherpa-onnx.node: undefined symbol: SherpaOnnxGetOnnxruntimeVersionStr`

### What it means

The local backend loads a native addon (`sherpa-onnx.node`) that depends on
`libsherpa-onnx-c-api.so`. The dynamic loader identifies that library by name, so if a
**different version** of it is already loaded in the same process, the addon binds to the
older copy and a symbol that only the newer version exports is missing. The loader then
terminates the process outright — this is not something the extension can catch, log, or
fall back from.

In practice it happens after an install change: Pi was started against one copy of
pi-voicekit (a local checkout, or an older npm version) and then reloaded, upgraded, or
repointed at another one that resolves a different `sherpa-onnx-node` release. The running
process still holds the version it loaded first.

### Fix

Restart Pi. A fresh process loads exactly one sherpa-onnx version and works.

Switching or upgrading the install source (`pi install` / `pi remove`) needs a restart, not a
`/reload`: a reload swaps the extension code but cannot unload a shared library that is
already mapped into the process.

With several Pi sessions open, the ones started before the change are the ones at risk —
restart them as well, or run `/voice off` in those sessions.

If the crash persists on a fresh start, report the two versions involved:

```sh
node -p "require(require.resolve('sherpa-onnx-node/package.json')).version"   # the JS wrapper
find ~/.pi -name 'libsherpa-onnx-c-api.so' 2>/dev/null                          # every native copy on disk
```

## Symptom: recording starts, but transcription is empty or says "No speech detected"

### Likely causes
- Recording was too short
- Microphone input level is too low
- Background noise or device permissions interfered
- Microphone is muted or pointing at wrong input device

### Fixes
- Hold the record key longer (at least 2-3 seconds of speech)
- Run `/voice test` to validate mic capture — check the byte count
- On macOS: System Settings → Privacy & Security → Microphone — ensure your terminal app has access
- Try `Ctrl+Shift+V` instead of hold-SPACE if the hold detection isn't working for your terminal

## Symptom: "Microphone captured no audio"

### What it means
SoX's `rec` command ran but produced zero audio data. This usually means a permissions issue.

### Fix (macOS)
1. System Settings → Privacy & Security → Microphone
2. Enable microphone access for your terminal app (Ghostty, Terminal, iTerm2, etc.)
3. You may need to restart the terminal after granting access

### Fix (Linux)
- Check PulseAudio/PipeWire is running: `pactl info`
- Verify recording works: `rec -d 2 /tmp/test.wav && play /tmp/test.wav`

## Symptom: space doesn't activate voice

### Common causes
- Voice is disabled — run `/voice on`
- No local model selected — run `/voice-setup` and pick one in the Models tab
- Typing cooldown active — if you were just typing, wait 400ms before holding SPACE
- You're in a picker, search, or other non-editor context — use `Ctrl+Shift+V` instead

### What to check
- `/voice test` — the `local model` line should name a model, and `state` should be `idle`
- The status bar reads `MIC LOCAL` when voice is ready; `MIC SETUP` means no model is selected

## Symptom: voice triggers accidentally while typing

### What it means
Your terminal may be sending key-repeat events faster than expected. The typing cooldown (400ms) should prevent this in most cases.

### Workarounds
- Use `Ctrl+Shift+V` exclusively (toggle mode, no hold detection involved)
- The hold threshold is 700ms — `/voice-hold-delay` accepts 200–3000 ms, so raise it if a
  normal space press still trips the detector

## Symptom: transcription times out

### What it means
Recognition runs in process, so this is not a network call. `Transcription timed out (120s)` comes
from the engine itself: either the recording is longer than the engine can finish inside that window
on this CPU, or the native runtime is in a bad state after an install change.

### Fix
- Run `/voice test` — it reports whether the sherpa-onnx runtime loads at all
- Restart Pi if you switched or upgraded pi-voicekit since it started
- Dictate in shorter bursts (`/voice dictate` accepts `/voice stop` at any time), or pick a faster
  model in the Device tab

## Symptom: the model download fails, or the model never reaches ready

### What it means

Model files are the only thing pi-voicekit fetches from the network: the speech model, the TTS
model and the ~285 MB punctuation model, downloaded once on first use from `huggingface.co` or
`github.com`. A download that fails, or a model that stays unusable, means that single outbound
step is blocked — a proxy, a firewall, DNS, an offline machine — or the disk is full.

### Fix

- Retry. A partial download is kept next to the target file and resumed with a `Range` request,
  so the next attempt starts where the last one stopped.
- Check free space in the settings panel's **Device** tab (`/voice-settings`). Only the
  speech-model install from `/voice-models` runs a precheck: it refuses to start when the volume
  cannot hold 1.2× the model size, and reports the free and required megabytes in the error. The
  TTS install, the punctuation transfer and a first-use auto-download have no such precheck, so
  on a full disk they fail mid-write instead.
- If retries keep failing on a partial file, delete the model in the **Downloaded** tab (select
  it, press `x` twice) or remove its directory and fetch it again. Speech models live at
  `~/.pi/models/<model-id>/`; TTS models live one level deeper, at `~/.pi/models/tts/<model-id>/`,
  so the shorter path is a no-op for a voice. The Downloaded tab lists every directory under
  `~/.pi/models`, so the TTS collection appears as one aggregate `tts` row — deleting that row
  removes every installed TTS model.
- Confirm the machine can reach both download hosts. Every speech model and the punctuation model
  come from `huggingface.co`; TTS archives come from `github.com`. Those two are the initial
  download sources, not the whole allowlist: the requests follow redirects, and a GitHub release
  download is answered from a separate asset host (`*.githubusercontent.com`), so that host must be
  reachable too. Blocking `github.com` breaks only the TTS install — speech recognition still
  installs; blocking `huggingface.co` stops both speech recognition and punctuation.

Once the files are on disk, dictation, punctuation and speech all work with the network down —
the download is the only outbound step this extension takes.

## Symptom: last word gets cut off

### What it means
You released SPACE before finishing your sentence. The tail recording feature (1.5s) should catch trailing words, but if you pause longer than that before the final word, it may be missed.

### Workaround
- Finish speaking before releasing SPACE
- Or use `/voice dictate` for continuous dictation (no hold needed)

## Symptom: a Chinese dictation came back without punctuation

### What it means

Offline punctuation runs only when all of these hold: `punctuationEnabled` resolves to on,
the transcript contains Chinese, and the text carries fewer than one punctuation mark per
20 characters. The switch resolves so that a machine-wide `false` is final — no project
block can re-enable it — and otherwise an explicit project value wins over the global one.
A transcript that fails the rule gets no mark added, and neither does one whose
punctuation fails at any point — the step is fail-open, so "no punctuation" always means
"nothing was inserted", never "text was lost".

The model is a one-time ~285 MB download, fetched in the background from the moment a session
starts — or, on a machine where that did not happen, the first time a dictation needs it.
Either way a dictation that arrives while the download is still running gets no mark added.
Once the download has completed, verified against its digest and the engine has been
constructed — any of which can fail — later qualifying dictations are punctuated; until
then they get no mark added, and `/voice-punctuation status` reports the state. On a fresh
install this is the usual explanation.

### Fix

- Run `/voice-punctuation status`. It prints the switch state, whether the model is
  present and digest-verified, and the last decision of this session with the reason
  (`not-needed`, `no-model`, `load-failed`, `altered-text`, `error`) and the marks
  before/after.
- `model: not downloaded` — wait for the background download (~285 MB), then dictate
  again.
- `last: ... not-needed` — the switch is off, the transcript contained no Chinese, or its
  punctuation was already dense enough (one mark per 20 characters or more). `status` prints
  the switch separately, so the other two are the remaining reasons.
- `model: unusable` — the download is incomplete or corrupt. Delete it in the settings
  panel's Downloaded tab (or remove `~/.pi/models/punct-ct-transformer-zh-en/`) and let a
  later dictation fetch it again.
- Run with `PI_VOICE_DEBUG=1` and search the log for the `punctuation` line: it carries
  the character count, marks before and after, the reason when it did not run, and the
  elapsed milliseconds.

## Symptom: project config is ignored

### What it means
Either:
- The config was saved globally instead of at project scope
- The project does not have `.pi/settings.json`

### Fix
1. Open `/voice-settings`, go to the **General** tab and set **Scope** to `Project (this repo)`;
   the next save writes the repository's `.pi/settings.json`
2. Inspect both files:
   - `~/.pi/agent/settings.json` (global)
   - `<project>/.pi/settings.json` (project)
3. Project settings override global settings — with one exception: a machine-wide `false`
   for `punctuationEnabled`, `fillerRemovalEnabled` or `numeralNormalizationEnabled` is
   final, so no project block can turn that step back on

## Debug logging

Set `PI_VOICE_DEBUG=1` to enable verbose debug logging:

```sh
PI_VOICE_DEBUG=1 pi
```

Logs go to stderr and to a file at `$TMPDIR/pi-voice-debug.log`. This shows the full state machine
transitions, key events, model and download decisions, and — for the punctuation step — the gate,
the reason it did not run and the marks before and after. It also includes a 100-character preview of
each transcript, so treat the file as sensitive.

## If you are still stuck

Capture these pieces of information before asking for help:

1. `/voice test` output
2. Your OS, terminal app, and Pi version
3. The selected local model and whether `/voice test` reports the sherpa-onnx runtime as loaded
4. Debug log (run with `PI_VOICE_DEBUG=1`)
