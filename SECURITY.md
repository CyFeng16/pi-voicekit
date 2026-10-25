# Security Policy

## Supported Versions

| Version | Supported        |
| ------- | ---------------- |
| 0.6.x   | ✅ Active support |
| < 0.6   | ❌ Not supported — those releases still carry the cloud backends; upgrade |

> **Audit status.** The most recent audit on record is dated 2026-03-12 and covered the pre-3.0
> codebase — upstream's `v3.x` numbering, which this fork's `0.6.0` version line does not belong to.
> It says nothing about 0.6.0, and no audit of this version exists.

## Reporting a Vulnerability

If you discover a security vulnerability in pi-voicekit, **please report it responsibly.**

### How to Report

1. **Do NOT open a public GitHub issue** for security vulnerabilities
2. GitHub private advisory: open one from the [Security tab](https://github.com/CyFeng16/pi-voicekit/security/advisories/new)
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact assessment
   - Suggested fix (if any)

### Response Timeline

- **Acknowledgment:** Within 48 hours
- **Assessment:** Within 7 days
- **Fix release:** Within 30 days for confirmed vulnerabilities

### Scope

The following are **in scope** for security reports:

| Area | Examples |
|------|----------|
| Audio handling | Temp-file handling and permissions, audio data leakage |
| Config files | Unsafe deserialization, credentials left behind by the upgrade scrub |
| Subprocess spawning | Command injection through capture or playback arguments |
| Model downloads | Path traversal in archive extraction, a digest check that can be bypassed |
| Dependencies | Known CVEs in direct dependencies |

The following are **out of scope:**

| Area | Reason |
|------|--------|
| Model hosting | Files come from HuggingFace and GitHub releases. Integrity is checked locally (see below), but the hosts themselves are not in our threat model |
| Denial of service via long recordings | Self-inflicted: recording auto-stops after 120 s |

## Security Design Principles

pi-voicekit follows these security principles:

### 1. No audio is uploaded to a remote speech service

Recording, recognition, punctuation and speech synthesis run inside the Pi process on
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx); no audio is sent to a speech service anywhere.
There is no endpoint to configure and no credential to store.

One supported configuration puts data off the machine, by the user's own choice rather than by the
extension's design.

**System audio routing.** Playback hands the synthesised WAV to the system player, which inherits the
environment. With `PULSE_SERVER` (or an SSH/remote-desktop audio session) pointed at another host, the
player sends the speech there. Capture honours the same variable, so a remote microphone means the
voice crosses that link before this extension receives it.

The claim is about audio, and the text a user sends is a separate path rather than a second exception:
a transcript — typed, or dictated and then submitted with `↵` — leaves the editor as a message to Pi
and goes to whichever model Pi is configured with, exactly like any other prompt.

So the claim covers transmission to a speech service, not every byte that can cross an interface:
local playback writes a temp WAV and hands it to a system player (`afplay`, `paplay`/`aplay`,
PowerShell `SoundPlayer`) — a local subprocess that runs on the same host (`tts-playback.ts`).

The enforceable half of the claim is [`tests/no-cloud-egress.test.ts`](tests/no-cloud-egress.test.ts):
it fails when a module imports the removed WebSocket transport, names a retired vendor identifier or
host, or calls `fetch` outside the two model-download modules. It binds the transport and the vendor
this repository deleted; it is not a proof that no future code could open a socket, which is why the
product claim is written as what the test checks rather than as an absolute.

**Not** in this guarantee: model downloads. Model files are fetched once, on first use, from
HuggingFace or GitHub releases.

### 2. No Telemetry

pi-voicekit does not collect, transmit, or store any usage data, analytics, or telemetry. No
telemetry, analytics or crash reporting is transmitted: there is no crash reporter and no remote
logging.

### 3. Minimal Attack Surface

- No persistent storage of audio recordings — a dictation lives in a memory buffer and is dropped
  once the transcript is written
- No network listeners; nothing in the extension binds a port
- Audio capture streams from the capture tool's stdout (no temp file); the `/voice test` probe
  writes a one-second WAV to the temp directory, reads its size and deletes it
- Speech playback writes a temp WAV with mode `0600` and unlinks it when playback ends
- Recording auto-stops after 120 seconds

### 4. Defense in Depth

- **No credentials at rest.** 0.6.0 removes both cloud backends, so there is no key to store. On the
  first start after an upgrade the extension erases a retired `deepgramApiKey` and `localEndpoint`
  from `settings.json` — editing the raw text so every other byte of the file survives — and announces
  it. A `DEEPGRAM_API_KEY` exported from a shell profile or `~/.env.secrets` is no longer read, and the
  extension does not edit those files.
- **Model integrity.** The punctuation model is verified file by file against the SHA-256 digests
  recorded in this repository, and a mismatch reports the model as absent rather than usable. Speech
  models are checked for presence and expected size; TTS archives have their SHA-256 computed and
  returned, but the catalogue does not pin those hashes yet — a known gap, not a claim of full
  verification.
- **Downloads land in one place.** Model files go under `~/.pi/models/`; a download is written to a
  `.tmp` / `.partial` path and renamed only when complete, so a half-written file is never mistaken
  for a model.
- **No secrets in output.** Error messages carry paths and states, not values. `PI_VOICE_DEBUG=1`
  diagnostics stay on the local disk (including a 100-character transcript preview) and are off by
  default.
- **Archive extraction is confined to a staging directory.** `tar` runs with `-C` pointing at a
  per-process `.staging-<pid>` directory next to the model directory, and the extracted files are moved
  into place only when extraction succeeds.
- **Session corruption guard** prevents overlapping recording sessions; the transcription call has a
  120 s timeout so a wedged engine cannot hold a session open forever.

### 5. Principle of Least Privilege

- Runs as the current user (no root required)
- Writes only to Pi's settings files, `~/.pi/models/` and the OS temp directory
- The one privileged-looking action — spawning a player or a capture tool — is done with an argument
  vector, never a shell string; the Windows player receives its path through an environment variable
  rather than interpolated into the command
