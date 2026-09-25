[English](README.md) | [简体中文](i18n/README.zh-CN.md) | [日本語](i18n/README.ja.md) | [한국어](i18n/README.ko.md) | [Español](i18n/README.es.md) | [Français](i18n/README.fr.md) | [Português](i18n/README.pt-BR.md) | [हिन्दी](i18n/README.hi.md)

# pi-voicekit

> **Community continuation of [`codexstar69/pi-listen`](https://github.com/codexstar69/pi-listen)** (upstream, MIT — dormant since v7.2.2 in May 2026).
> Not affiliated with the original author. Old name: `pi-listen`.

<p align="center">
  <img src="https://raw.githubusercontent.com/CyFeng16/pi-voicekit/main/assets/brand/banner-en.png" alt="pi-voicekit — Voice input and output for the Pi coding agent" width="100%" />
</p>

**Voice in and voice out for [Pi](https://github.com/earendil-works/pi-coding-agent).**
Hold-to-talk STT — Deepgram streaming (cloud) or 21 offline models — plus TTS that
speaks the agent's replies (Kitten, Kokoro, Piper, or Deepgram Aura).

[![npm version](https://img.shields.io/npm/v/pi-voicekit.svg)](https://www.npmjs.com/package/pi-voicekit)
[![license](https://img.shields.io/npm/l/pi-voicekit.svg)](https://github.com/CyFeng16/pi-voicekit/blob/main/LICENSE)
[![original author](https://img.shields.io/badge/original_author-@baanditeagle-1DA1F2?logo=x&logoColor=white)](https://x.com/baanditeagle)

> **v0.1.3 — current release** — audio capture prefers `ffmpeg` when
> `PULSE_SERVER` is set (SSH audio tunnel / remote PulseAudio), so remote
> microphones record reliably. Voice in **and** voice out: 21 offline STT models,
> 20 local TTS voices plus Deepgram Aura, driven by one `/voice-settings` panel
> with 6 tabs. The 0.1.x line is documented in the [changelog](CHANGELOG.md).

---

## See How It Works

<p align="center">
  <a href="https://github.com/CyFeng16/pi-voicekit/blob/main/assets/demo/pi-voicekit-demo.mp4">
    <img src="https://raw.githubusercontent.com/CyFeng16/pi-voicekit/main/assets/brand/banner-en.png" alt="Watch demo video" width="600" />
  </a>
  <br>
  <em>Click to watch the demo video</em>
</p>

---

## Setup (2 minutes)

### 1. Install the extension

```bash
# In a regular terminal (not inside Pi)
pi install npm:pi-voicekit
```

### 2. Choose your backend

pi-voicekit supports two transcription backends:

|                  | Deepgram (cloud)                                         | Local models (offline)                              |
| ---------------- | -------------------------------------------------------- | --------------------------------------------------- |
| **How it works** | Live streaming — text appears as you speak               | Batch mode — transcribes after you finish recording |
| **Setup**        | API key required                                         | No API key, models auto-download on first use       |
| **Internet**     | Required                                                 | Not required after model download                   |
| **Latency**      | Real-time interim results                                | 2–10 seconds after recording stops                  |
| **Languages**    | 56+ with live streaming                                  | Depends on model (1–57 languages)                   |
| **Cost**         | $200 free credit (lasts 6–12 months for most developers) | Free forever                                        |

Run `/voice-settings` inside Pi to choose your backend and configure everything from one panel.

#### Option A: Deepgram (recommended for live streaming)

Sign up at [dpgr.am/pi-voice](https://dpgr.am/pi-voice) — $200 free credit, no card needed.

```bash
export DEEPGRAM_API_KEY="your-key-here"    # add to ~/.zshrc or ~/.bashrc
```

#### Option B: Local models (fully offline)

No setup needed — run `/voice-settings`, switch backend to Local, and select a model. It downloads automatically.

> **Note:** Local models use batch mode — they transcribe after you finish recording, not while you speak. For live streaming as you speak, use Deepgram.

### 3. Open Pi

On first launch, pi-voicekit checks your setup and tells you what's ready:

- Backend configured (Deepgram key or local model)
- Audio capture tool detected (sox, ffmpeg, or arecord)
- If everything checks out, voice activates immediately

### Audio capture

pi-voicekit auto-detects your audio tool. No manual install needed if you already have sox or ffmpeg.

| Priority | Tool            | Platforms             | Install                                                      |
| -------- | --------------- | --------------------- | ------------------------------------------------------------ |
| 1        | **SoX** (`rec`) | macOS, Linux, Windows | `brew install sox` / `apt install sox` / `choco install sox` |
| 2        | **ffmpeg**      | macOS, Linux, Windows | `brew install ffmpeg` / `apt install ffmpeg`                 |
| 3        | **arecord**     | Linux only            | Pre-installed (ALSA)                                         |

> When `PULSE_SERVER` is set (SSH audio tunnel or remote PulseAudio) the order
> becomes **ffmpeg → sox → arecord** — network Pulse sources need ffmpeg.

---

## Settings Panel

All configuration lives in one place: `/voice-settings`. Six tabs cover everything you need.

### General — backend, language, scope

<img src="https://raw.githubusercontent.com/CyFeng16/pi-voicekit/main/assets/screenshots/settings-general.png" alt="General settings — backend, model, language, scope, voice toggle" width="600" />

Toggle between Deepgram (cloud, live streaming) and Local (offline, batch mode). Change language, scope, and enable/disable voice — all with keyboard shortcuts.

### Models — browse, search, install

<img src="https://raw.githubusercontent.com/CyFeng16/pi-voicekit/main/assets/screenshots/settings-models.png" alt="Models tab — browse 21 models with accuracy/speed ratings" width="600" />

Browse 21 models from Parakeet, Whisper, Moonshine, SenseVoice, GigaAM, Paraformer, and Qwen3. Each model shows accuracy and speed ratings (●●●●○/●●●●○), fitness badges, and download status. Fuzzy search to find models fast. Press Enter to activate and download.

### Downloaded — manage installed models

<img src="https://raw.githubusercontent.com/CyFeng16/pi-voicekit/main/assets/screenshots/settings-downloaded.png" alt="Downloaded tab — manage installed models, activate or delete" width="600" />

See what's installed, total disk usage, and which model is active. Press Enter to activate, `x` to delete. Models from [Handy](https://github.com/cjpais/handy) are auto-detected and can be imported without re-downloading.

### Speak — TTS models and voices

Pick a TTS backend (local sherpa-onnx or Deepgram Aura), browse 20 local voices
from ~13 MB, download on selection, and choose a voice per backend. Auto-speak of
agent replies is toggled here.

### Device — hardware profile and dependencies

<img src="https://raw.githubusercontent.com/CyFeng16/pi-voicekit/main/assets/screenshots/settings-device.png" alt="Device tab — hardware profile, dependencies, disk space" width="600" />

See your hardware profile (RAM, CPU, GPU), dependency status (sherpa-onnx runtime), available disk space, and total downloaded models. Model recommendations are based on this profile.

### Polish — transcript cleanup

Optional post-ASR cleanup, on by default. Toggle it, pick the model, set how many
recent conversation turns accompany the transcript (0–10), and cap how long one
pass may take (`1000`–`30000` ms). The last row shows the most recent polished
dictation as a `RAW` / `POLISHED` pair — the same pair `/voice-polish last` prints.

`/voice-polish` takes `on`, `off`, `model`, `turns <0-10>`, `last` and `restore`;
run it with no argument for the current status.

---

## Usage

### Keybindings

| Action               | Key                  | Notes                                                                   |
| -------------------- | -------------------- | ----------------------------------------------------------------------- |
| **Record to editor** | Hold `SPACE` (≥0.7s) | Release to finalize. Pre-records during warmup so you don't miss words. |
| **Toggle recording** | `Ctrl+Shift+V`       | Works in all terminals — press to start, press again to stop.           |
| **Clear editor**     | `Escape` × 2         | Double-tap within 500ms to clear all text.                              |

### How recording works

1. **Hold SPACE** — warmup countdown appears, audio capture starts immediately (pre-recording)
2. **Keep holding** — live transcription streams into the editor (Deepgram) or audio buffers (local)
3. **Release SPACE** — recording continues for 1.5s (tail recording) to catch your last word, then finalizes
4. Text appears in the editor, ready to send

### Commands

| Command                  | Description                                               |
| ------------------------ | --------------------------------------------------------- |
| `/voice-settings`        | Settings panel — backend, models, language, scope, device |
| `/voice-models`          | Settings panel (Models tab)                               |
| `/voice-setup`           | Run the first-run setup wizard                            |
| `/voice-language`        | Open the settings panel to change language                |
| `/voice-speak <text>`    | Speak text out loud (TTS)                                 |
| `/voice-speak-test`      | Speak a sample sentence                                   |
| `/voice-speak-toggle`    | Enable / disable TTS                                      |
| `/voice-stream`          | Toggle Deepgram streaming TTS (cloud)                     |
| `/voice-speak-stop`      | Stop in-flight TTS playback                               |
| `/voice-autosubmit`      | Toggle: STT text auto-sent to the agent (`on`/`off`)      |
| `/voice-polish [sub]`    | Transcript polish: on, off, model, turns, last, restore   |
| `/voice-hold-delay`      | Set hold-to-talk delay (200-3000 ms, default 700)         |
| `/voice-speak-models`    | Browse / install TTS voice models                         |
| `/voice-speak-info`      | Diagnose TTS state                                        |
| `/voice-help`            | Keyboard + command reference (or press `F1`)              |
| `/voice test`            | Full diagnostics — audio tool, mic, API key               |
| `/voice on` / `off`      | Enable or disable voice                                   |
| `/voice dictate`         | Continuous dictation (no key hold)                        |
| `/voice stop`            | Stop active recording or dictation                        |
| `/voice history`         | Recent transcriptions                                     |
| `/voice`                 | Toggle on/off                                             |

### v7.1 keyboard

While in the settings panel:

| Key    | Action                              |
| ------ | ----------------------------------- |
| `← →`  | switch tab                          |
| `↑ ↓`  | navigate row (skips group headings) |
| `↵`    | select / activate                   |
| `esc`  | back to main / close panel          |
| `type` | filter (search)                     |
| `bksp` | clear last search char              |

While an install widget or playback indicator is mounted (no overlay
in front):

| Key   | Action                                                        |
| ----- | ------------------------------------------------------------- |
| `esc` | cancel active install (most-recent first), then stop playback |
| `F1`  | open help overlay (always available)                          |

---

## Local Models

21 models across 7 families. Sorted by quality — best models first.

### Top picks

| Model               | Accuracy | Speed | Size   | Languages        | Notes                      |
| ------------------- | -------- | ----- | ------ | ---------------- | -------------------------- |
| **Parakeet TDT v3** | ●●●●○    | ●●●●○ | 671 MB | 25 (auto-detect) | Best overall. WER 6.3%.    |
| **Parakeet TDT v2** | ●●●●●    | ●●●●○ | 661 MB | English          | Best English. WER 6.0%.    |
| **Whisper Turbo**   | ●●●●○    | ●●○○○ | 1.0 GB | 57               | Broadest language support. |

### Fast and lightweight

| Model                 | Accuracy | Speed | Size   | Languages       | Notes                                |
| --------------------- | -------- | ----- | ------ | --------------- | ------------------------------------ |
| **Moonshine v2 Tiny** | ●●○○○    | ●●●●● | 43 MB  | English         | 34ms latency. Raspberry Pi friendly. |
| **Moonshine Base**    | ●●●○○    | ●●●●● | 287 MB | English         | Handles accents well.                |
| **SenseVoice Small**  | ●●●○○    | ●●●●● | 228 MB | zh/en/ja/ko/yue | Best for CJK languages.              |

### Specialist

| Model                | Accuracy | Speed | Size   | Languages | Notes                                  |
| -------------------- | -------- | ----- | ------ | --------- | -------------------------------------- |
| **GigaAM v3**        | ●●●●○    | ●●●●○ | 225 MB | Russian   | 50% lower WER than Whisper on Russian. |
| **Whisper Medium**   | ●●●●○    | ●●●○○ | 946 MB | 57        | Good accuracy, medium speed.           |
| **Whisper Large v3** | ●●●●○    | ●○○○○ | 1.8 GB | 57        | Highest Whisper accuracy. Slow on CPU. |

Plus 8 language-specialized Moonshine v2 variants for Japanese, Korean, Arabic, Chinese, Ukrainian, Vietnamese, and Spanish.

### How local models work

```
Hold SPACE → audio captured to memory buffer
                ↓
Release SPACE → buffer sent to sherpa-onnx (in-process)
                ↓
         ONNX inference on CPU (2–10 seconds)
                ↓
         Final transcript inserted into editor
```

Models download automatically on first use. Downloads are resumable, verified after completion, and deduplicated (no double-downloads). The settings panel shows real-time download progress with speed and ETA.

Models from [Handy](https://github.com/cjpais/handy) (`~/Library/Application Support/com.pais.handy/models/`) are auto-detected and can be imported via symlink (zero disk duplication).

---

## Features

| Feature                          | Description                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| **Dual backend**                 | Deepgram (cloud, live streaming) or local models (offline, batch) — switch in settings   |
| **21 local models**             | Parakeet, Whisper, Moonshine, SenseVoice, GigaAM, Paraformer, Qwen3 — with accuracy/speed ratings |
| **Unified settings panel**       | One overlay panel for all configuration — `/voice-settings`                              |
| **Device-aware recommendations** | Scores models against your hardware. Only best-in-class models get [recommended].        |
| **Enterprise download pipeline** | Pre-checks (disk, network, permissions), live progress with speed/ETA, post-verification |
| **Handy integration**            | Auto-detects models from Handy app, imports via symlink                                  |
| **Audio fallback chain**         | Tries sox → ffmpeg → arecord in order — ffmpeg first when `PULSE_SERVER` is set          |
| **Pre-recording**                | Audio capture starts during warmup — you never miss the first word                       |
| **Tail recording**               | Keeps recording 1.5s after release so your last word isn't clipped                       |
| **Live streaming**               | Deepgram Nova 3 WebSocket (Nova 2 for Chinese locales) — live interim transcripts        |
| **Transcript polish**            | Optional post-ASR cleanup — every dictation makes one extra model call; the last N conversation turns (default 2) are sent with it, plus the compaction summary after one — both only while the turn count is above zero. Disable with `/voice-polish off` |
| **56+ languages**                | Deepgram: 56+ with live streaming. Local: up to 57 depending on model.                   |
| **Continuous dictation**         | `/voice dictate` for long-form input without holding keys                                |
| **Typing cooldown**              | Space holds within 400ms of typing are ignored                                           |
| **Sound feedback**               | macOS system sounds for start, stop, and error events                                    |
| **Cross-platform**               | macOS, Windows, Linux — Kitty protocol + non-Kitty fallback                              |

---

## Architecture

```
# core
extensions/voice.ts                         Main extension — state machine, recording, UI, command surface
extensions/voice/config.ts                  Config loading, saving, migration
extensions/voice/onboarding.ts              First-run wizard, language picker
extensions/voice/audio-tool.ts              Capture tool detection (sox / ffmpeg / arecord)
extensions/voice/hold-to-talk.ts            Hold detection, Kitty and non-Kitty terminals
extensions/voice/release-controller.ts      Recording lifecycle, release handling

# speech-to-text
extensions/voice/deepgram.ts                Deepgram URL builder, API key resolver
extensions/voice/local.ts                   Model catalog (21 models), in-process transcription
extensions/voice/sherpa-engine.ts           sherpa-onnx bindings — recognizer lifecycle, inference
extensions/voice/sherpa-loader.ts           Lazy native module loading
extensions/voice/model-download.ts          Download manager — resume, progress, verification, Handy import
extensions/voice/device.ts                  Device profiling — RAM, GPU, CPU, container detection

# transcript post-processing
extensions/voice/post-process.ts            Polish pass — fail-open guardrails, model resolution, bounded call
extensions/voice/post-process-context.ts    Context assembly — recent turns, compaction summary, character caps
extensions/voice/post-process-prompt.ts     Fixed polish prompt and request shape

# text-to-speech
extensions/voice/speak.ts                   Speak entry point, auto-speak wiring
extensions/voice/tts-engine.ts              sherpa-onnx TTS synthesis
extensions/voice/tts-deepgram.ts            Deepgram Aura voices (cloud)
extensions/voice/tts-local-models.ts        Local TTS catalog — 20 voices (Kitten, Kokoro, Piper)
extensions/voice/tts-playback.ts            Playback, buffering, player detection
extensions/voice/tts-text-filter.ts         Code-block stripping, sentence prep
extensions/voice/tts-onboarding.ts          TTS onboarding flow
extensions/voice/tts-onboarding-overlay.ts  TTS onboarding overlay
extensions/voice/tts-install-progress.ts    Model install progress widget
extensions/voice/tts-playback-indicator.ts  Speaking indicator widget

# settings and UI
extensions/voice/settings-panel.ts          Settings panel — overlay, 6 tabs
extensions/voice/ui-picker.ts               Generic list picker
extensions/voice/ui-help-overlay.ts         Keyboard and command reference
extensions/voice/ui-aura.ts                 Visual primitives (Liquid Braille, Aurora)
extensions/voice/ui-widget-base.ts          Widget registry and base class
extensions/voice/ui-render-ticker.ts        Shared render ticker
extensions/voice/ui-icons.ts                Glyph and icon set
extensions/voice/ui-width.ts                CJK-aware visual width helpers
extensions/voice/ui-locale-labels.ts        Native language and voice labels

# types
extensions/voice/sherpa-onnx-node.d.ts      Type declarations for the optional native module
```

---

## Configuration

Settings stored in Pi's settings files under the `voice` key:

| Scope   | Path                          |
| ------- | ----------------------------- |
| Global  | `~/.pi/agent/settings.json`   |
| Project | `<project>/.pi/settings.json` |

```json
{
	"voice": {
		"version": 3,
		"enabled": true,
		"language": "en",
		"backend": "local",
		"localModel": "parakeet-v3",
		"scope": "global",
		"onboarding": { "completed": true, "schemaVersion": 3 }
	}
}
```

`DEEPGRAM_API_KEY` from your shell is used at runtime and is not copied back
into `~/.pi/agent/settings.json`. If you paste a key during onboarding, that is
an explicit save and it still goes to `~/.env.secrets` or `~/.zshrc`.

Hold-to-talk delay defaults to **700 ms** (`/voice-hold-delay` accepts 200–3000 ms).

### Transcript polish

| Setting                   | Scope              | Default     | Notes                                                   |
| ------------------------- | ------------------ | ----------- | ------------------------------------------------------- |
| `postProcessEnabled`      | global only        | `true`      | Master switch. A project `voice` block cannot flip it.  |
| `postProcessModel`        | global only        | `"session"` | Reuses the session model, or `provider/modelId`.        |
| `postProcessContextTurns` | global and project | `2`         | Conversation turns sent with the transcript, `0`–`10`.  |
| `postProcessTimeoutMs`    | global and project | `8000`      | Per-pass timeout in milliseconds, `1000`–`30000`.       |

The global-only fields resolve from `~/.pi/agent/settings.json` even when a
repository provides its own `voice` block, so a cloned repo can neither turn the
feature on nor redirect where dictated text goes. The model is chosen from a
picker (`/voice-polish model`), never typed: a hand-typed reference is refused,
and an unavailable or malformed model keeps the raw transcript instead of
switching provider. `postProcessNoticeShown` is machine-local bookkeeping for the
one-time notice, not a user setting.

---

## Troubleshooting

Run `/voice test` inside Pi for full diagnostics.

| Problem                                          | Solution                                                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| "DEEPGRAM_API_KEY not set"                       | [Get a key](https://dpgr.am/pi-voice) → `export DEEPGRAM_API_KEY="..."` in `~/.zshrc`                           |
| "No audio capture tool found"                    | `brew install sox` or `brew install ffmpeg`                                                                     |
| Remote microphone records silence                | Audio over PulseAudio/SSH — install ffmpeg on the Pi side (capture then prefers ffmpeg)                         |
| Space doesn't activate voice                     | Run `/voice-settings` — voice may be disabled                                                                   |
| Local model not transcribing                     | Check `/voice-settings` → Device tab for sherpa-onnx status                                                     |
| Download failed                                  | Partial downloads auto-resume on retry. Check disk space in Device tab.                                         |
| `dyld: Library not loaded: libsimdjson` on macOS | Homebrew Node ABI mismatch — run `brew reinstall node` or switch to version-managed Node (`mise`, `fnm`, `nvm`) |

---

## Security

- **Cloud STT** — audio is sent to Deepgram for transcription (Deepgram backend only)
- **Local STT** — audio never leaves your machine (local backend)
- **No telemetry** — pi-voicekit does not collect or transmit usage data
- **API key** — stored in env var or Pi settings, never logged

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

---

## License

[MIT](LICENSE) — original by [@baanditeagle](https://x.com/baanditeagle), maintained by [CyFeng16](https://github.com/CyFeng16)

---

<p align="center">
  <strong>Continuation of pi-listen by <a href="https://x.com/baanditeagle">@baanditeagle</a>, maintained by <a href="https://github.com/CyFeng16">CyFeng16</a></strong>
  <br><br>
  <a href="https://abhishektiwari.co">Website</a> · <a href="https://x.com/baanditeagle">𝕏 Twitter</a> · <a href="https://github.com/CyFeng16/pi-voicekit">GitHub</a> · <a href="https://www.npmjs.com/package/pi-voicekit">npm</a> · <a href="https://github.com/CyFeng16/pi-voicekit/issues">Report a Bug</a> · <a href="https://github.com/earendil-works/pi-coding-agent">Pi CLI</a>
</p>
