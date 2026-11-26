# Contributing to CrispType

Thank you for helping make CrispType faster, cleaner, and more accessible across Linux, Windows, and Android!

## Repository Map

```text
crisptype/
├── src/                      # Lightweight React + TypeScript client UI (<100 MB RAM)
│   ├── components/           # Sidebar, SettingsModal, FloatingDictationBar, FlowLogo
│   ├── pages/                # Dictation, Insights (42 WPM baseline), Dictionary, Style, Diagnostics
│   ├── services/             # api.ts (WS/HTTP + provider abstraction), audio.ts, hotkeys.ts, platform.ts
│   ├── store/                # Zustand state store + IndexedDB persistence
│   └── utils/                # Pure, unit-tested PCM audio, VAD, app classifier & text cleanup
├── server/                   # Optional Node.js transcription proxy & pipeline utilities
├── server.ts                 # Express + WebSocket dev/production entry point
├── backend/                  # Self-hosted Python FastAPI + C++17 Silero VAD + ASR + Llama 3.2 server
│   ├── app/                  # main.py, vad_bridge.py, asr_engine.py, llm_refiner.py, app_classifier.py
│   ├── native/               # Native C++17 Silero VAD (ONNX Runtime)
│   ├── setup.sh              # One-command self-host installer
│   └── docker-compose.yml    # Containerized deployment
├── src-tauri/                # Tauri v2 lightweight native wrapper (tray, hotkeys, overlay, auto-paste)
└── .github/workflows/        # Automated CI checks and multi-platform release packaging
```

## Development Setup

### 1. Client & Node Dev Server
```bash
npm install
npm run dev
```
Open `http://localhost:3000`.

### 2. Self-Hosted Python AI Backend
```bash
cd backend
bash setup.sh
```

### 3. Run Quality Checks Before Opening a PR
```bash
npm run lint                                       # TypeScript typecheck
npm test                                           # All Node.js unit & streaming tests
npm run build                                      # Production Vite bundle
python3 -m py_compile backend/app/*.py backend/keep_alive.py
```

## Engineering & Security Standards
1. **Zero secrets in git:** Never commit `.env` files, personal server URLs, or API keys. Add new env variables to `.env.example` and `backend/.env.example`.
2. **Zero-retention privacy:** Never write user transcripts to server logs and always delete ephemeral audio buffers/temp files inside `finally` blocks.
3. **Strict LLM data boundaries:** Always pass raw STT transcripts through `wrapUntrustedTranscript` / `wrap_untrusted_transcript` (`<transcript>...</transcript>`) before sending to Layer 2 LLMs.
4. **Graceful OS fallbacks:** Native desktop helpers (`src-tauri/src/lib.rs`) must never interpolate user text into a shell string and must always fall back cleanly to clipboard copy + `"General"` formatting if an OS utility (e.g., `xdotool` on Wayland) is unavailable.
5. **Unit-test pure logic:** Put parsing, audio packetization, VAD, rate limiting, and text cleanup in pure functions covered by `node:test`.

## Pull Request Checklist
- [ ] `npm run lint`, `npm test`, and `npm run build` pass cleanly.
- [ ] No hardcoded URLs, personal endpoints, or API keys were introduced.
- [ ] Any new environment variables are documented in `.env.example`.
- [ ] Changes are scoped cleanly and follow existing TypeScript / Python / Rust conventions.
