# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 3.x     | ✅ Active support   |
| < 3.0   | ❌ Not supported    |

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
| Audio handling | Temp file races, audio data leakage |
| Config files | Credential exposure, unsafe deserialization |
| Subprocess spawning | Command injection via SoX arguments |
| WebSocket streaming | Data integrity, connection hijacking |
| Dependencies | Known CVEs in direct dependencies |

The following are **out of scope:**

| Area | Reason |
|------|--------|
| Deepgram API key exposure | User-managed credential, documented in setup |
| Denial of service via long recordings | Local-only, self-inflicted (120s auto-stop cap) |

## Security Design Principles

pi-voicekit follows these security principles:

### 1. Cloud STT
Audio is streamed to Deepgram for transcription via encrypted WebSocket (wss://). No audio is stored locally or on the server after transcription.

### 2. No Telemetry
pi-voicekit does not collect, transmit, or store any usage data, analytics, or telemetry.

### 3. Minimal Attack Surface
- No persistent storage of audio recordings
- No network listeners (audio streams outbound only)
- SoX subprocess captures audio ephemerally (no temp files)
- Recording auto-stops after 120 seconds

### 4. Defense in Depth
- API key resolved from environment variable or config, never logged or included in error messages
- Env-derived `DEEPGRAM_API_KEY` values are runtime-only and are not persisted back into `~/.pi/agent/settings.json`
- Error responses do not expose stack traces or internal paths
- Connection timeout (10s) and stale session watchdog (15s) prevent hung resources
- Session corruption guard prevents overlapping recording sessions

### 5. Principle of Least Privilege
- Runs as the current user (no root required)
- No filesystem access beyond config files (~/.pi/agent/settings.json)
- Audio data flows only to Deepgram API (wss://api.deepgram.com)

## Recent Security Audit

**Date:** 2026-03-12 (pre-v3 codebase -- daemon and local backends have since been removed)
**Method:** Adversarial bug-hunter pipeline (Recon → Hunter → Skeptic → Referee)
**Scope:** Full codebase at time of audit (7 source files, 2948 lines)
**Results:**

| Metric | Count |
|--------|-------|
| Findings reported | 13 |
| Confirmed bugs | 8 |
| Security-relevant | 1 (CWE-200, fixed) |
| Fixed | 6 |
| Remaining (low severity) | 2 |

See `.bug-hunter/report.md` for the full audit report. Note: the v3 rewrite removed the daemon, local backends, and Unix socket -- the primary attack surface identified in that audit no longer exists.
