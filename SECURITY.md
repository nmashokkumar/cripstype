# Security Policy

## Reporting a Vulnerability

If you discover a security issue in CrispType, please report it privately through **GitHub Security Advisories** ("Report a vulnerability" under the Security tab) rather than opening a public issue.

Please include:
- A clear description of the issue and affected files.
- Steps to reproduce or a minimal proof of concept.
- Any suggested fix if you have one.

We aim to acknowledge reports within 48 hours and release a fix promptly.

## CrispType Security & Privacy Architecture

1. **Zero-Retention Audio Processing:**
   - Streaming WebSocket audio (`16 kHz` Int16 PCM) is buffered strictly in memory and zeroed/cleared immediately in `finally` blocks once transcription finishes or the socket closes.
   - Batch uploads decoded via `ffmpeg` use allowlisted extensions, strict timeouts, and guaranteed deletion in `finally` blocks.
   - Spoken user transcripts are never written to production server logs.
2. **Authentication & Abuse Controls:**
   - All HTTP transcription and health endpoints enforce constant-time `Authorization: Bearer <API_KEY>` / `X-API-Key` verification when `CRISPTYPE_API_KEY` is configured.
   - WebSocket sessions authenticate via upgrade headers or the initial encrypted-over-WSS JSON `start` frame—API keys are never placed in WebSocket URL query strings.
   - Built-in sliding-window rate limiting, maximum upload limits (25 MB), WebSocket frame size limits (256 KB), and concurrent WebSocket per-IP caps protect self-hosted servers.
   - Wildcard CORS (`*`) is automatically rejected whenever API key authentication is enabled.
3. **Layer 2 LLM Prompt-Injection Boundaries:**
   - Raw speech-to-text transcripts are isolated inside strict `<transcript>...</transcript>` delimiters (with embedded tags stripped) so dictated words cannot override Layer 2 formatting rules.
4. **Local-Only History & Settings:**
   - Dictation history, personal dictionary, and insights stats live strictly in the user's local IndexedDB/storage on their device.
