# Flow — Open-Source Cross-Device Voice Dictation

**Flow** is a clean, cross-platform, self-hostable voice dictation client and backend built for **Windows (`.exe`)**, **macOS (`.dmg`)**, **Linux (`.deb`)**, **Android (`.apk`)**, and **Web**.

Speak naturally in any app. Flow automatically detects the active application, streams 16 kHz PCM audio to your self-hosted server, removes silence using **native C++17 Silero VAD v5**, transcribes speech via **SeamlessM4T v2** or **Faster-Whisper**, and refines tone, fillers, self-corrections, and custom dictionary spellings with an **app-aware Layer 2 LLM**.

---

## Architecture

| Layer | Technology | Responsibility |
| --- | --- | --- |
| **Client UI** (`/src`) | React 19, TypeScript, Tailwind CSS v4, Zustand, IndexedDB | OS-agnostic frontend wrapping cleanly in Electron, Tauri, or Capacitor. |
| **Native Bridge** (`/src/services/platform.ts`) | `window.flowNative` / `window.electronAPI` | Cross-platform active app detection, global hotkeys, clipboard/paste injection, and overlay pointer pass-through. |
| **Voice Activity Detection** (`/backend/native/silero_vad.cpp`) | **C++17 + ONNX Runtime C++ API** (`libsilero_vad.so`) | Ultra-low-latency 32 ms frame speech segmentation with zero Python GIL overhead. |
| **Transcription & Refinement** (`/backend/app`) | FastAPI, WebSockets, SeamlessM4T v2 / Faster-Whisper, Layer 2 LLM | Real-time 16 kHz Int16 PCM WebSocket streaming + app-aware style & dictionary polishing. |

---

## Quick Start (For Users — Zero Terminal Hassle)

### 1. Start Your Free Backend Server (Instabox.sh / Ubuntu / Debian)

Open any Instabox.sh VM or Linux machine and run **one command**:

```bash
git clone https://github.com/nmashokkumar/my_wispr.git && cd my_wispr/backend && bash install.sh
```

Or run with Docker:

```bash
cd backend && cp .env.example .env && docker compose up -d
```

The installer compiles native C++ Silero VAD, downloads the model, starts port `8000`, and prints your **Server link** and optional **API key**.

### 2. Connect the Flow App

1. Open **Flow** → **Settings** → **Server**.
2. Paste your **Server link** (and optional **API key**).
3. Click **Connect**.

---

## Key Features

- **Automatic App-Aware Style Routing**: No manual app tagging. Flow detects the focused app automatically (`Gmail` / `Outlook` → Email/Formal, `WhatsApp` / `Telegram` → Personal/Very casual, `Slack` / `VS Code` / `Notion` → Work/Casual) and applies the tone rules you configure in **Style**.
- **Dual Independent Hotkeys**:
  - **Push-to-talk (Hold)**: `fn` by default — floating overlay shows live audio waves only.
  - **Hands-free (Toggle)**: `Ctrl + Alt + Space` by default — floating overlay shows waves, elapsed timer, and a clickable `✓` finish button (with 5s silence auto-stop).
- **Personal Dictionary**: Custom words and spoken replacements stored locally in IndexedDB and sent on every dictation session and batch re-transcription.
- **Local Insights**: Total words, average WPM, time saved, fillers removed, streak calendar, and auto-detected app usage computed entirely on-device.

---

## Local Development

```bash
npm install
npm run dev
```

Run tests:

```bash
npx tsx --test src/utils/appClassifier.test.ts src/utils/pcmAudio.test.ts src/utils/textPipeline.test.ts src/services/hotkeys.test.ts server/openwhisprPipeline.test.ts
```

---

## Native Wrapper Integration (`.exe` / `.deb` / `.dmg` / `.apk`)

To wrap the built frontend (`npm run build` → `dist/`) in Electron, Tauri, or Capacitor, expose `window.flowNative` (see `src/types/native.d.ts`):

```ts
window.flowNative = {
  getActiveApp: () => Promise.resolve({ appName: 'Gmail', windowTitle: 'Compose - Gmail' }),
  pasteText: (text) => injectIntoFocusedWindow(text),
  setOverlayIgnoreMouseEvents: (ignore, opts) => overlayWin.setIgnoreMouseEvents(ignore, opts),
  onDictationStart: (cb) => subscribeGlobalHotkeyStart(cb),
  onDictationStop: (cb) => subscribeGlobalHotkeyStop(cb),
  onDictationToggle: (cb) => subscribeGlobalHotkeyToggle(cb),
};
```
