import type {
  AsrModelOption,
  AutoCleanupConfig,
  DictionaryEntry,
  StyleContext,
  StylePreset,
  StylesByContext,
  TranscribeResponse,
} from '../types';
import {
  PCM_PACKET_BYTES,
  PCM_PACKET_SAMPLES,
  PcmPacketizer,
  TARGET_SAMPLE_RATE,
  deriveWebSocketUrl,
} from '../utils/pcmAudio';
import {
  applyLocalCleanupPipeline,
  countStrippedFillersAndCorrections,
  countWords,
} from '../utils/textPipeline';
import {
  computePcmPacketRms,
  diagnostics,
  formatPacketHexPreview,
} from './diagnostics';

export const LIVE_SEAMLESS_SERVER_URL = 'https://8000-agq75oq6i7eazd5pahfhehvvj4.instabox.tech';

export const DEFAULT_CLEANUP_CONFIG: AutoCleanupConfig = {
  removeFillerWords: true,
  applySelfCorrections: true,
  autoPunctuation: true,
  autoCapitalization: true,
};

export const ASR_MODEL_OPTIONS: Array<{ value: AsrModelOption; label: string; hint: string }> = [
  { value: 'auto', label: 'Server Default (Auto)', hint: 'Uses whichever ASR model the server has loaded' },
  { value: 'seamless-m4t-v2', label: 'SeamlessM4T v2', hint: 'Meta multilingual speech-to-text' },
  { value: 'faster-whisper-distil-large-v3', label: 'Faster-Whisper distil-large-v3', hint: 'Low-latency English/multilingual' },
  { value: 'faster-whisper-large-v3-turbo', label: 'Faster-Whisper large-v3-turbo', hint: 'High accuracy turbo model' },
];

export interface ApiClientConfig {
  baseUrl: string;
  apiKey?: string;
  mockMode: boolean;
  timeoutMs?: number;
}

export interface BatchTranscribePayload {
  audio: Blob;
  model?: AsrModelOption;
  style?: StylePreset;
  context?: StyleContext;
  appContext?: string;
  cleanup?: AutoCleanupConfig;
  dictionary: DictionaryEntry[];
  language?: string;
  filename?: string;
}

export interface ServerHealthResult {
  ok: boolean;
  latencyMs: number;
  message: string;
  asrEngine?: string;
  vadEngine?: string;
  llmProvider?: string;
  availableModels?: string[];
}

export interface ProcessedTranscribeResult {
  text: string;
  formatted_text: string;
  raw_text: string;
  num_words: number;
  language: string;
  duration_ms: number;
  app_context?: string;
  category?: StyleContext;
  style_applied?: StylePreset;
  packets_received?: number;
  pcm_bytes_received?: number;
  fillerRemovedCount: number;
  correctionsAppliedCount: number;
}

const MOCK_RAW_SAMPLES = [
  'um so can you send the the report to Sarah by uh Thursday actually no Friday and let her know its nearly done',
  'uh btw i just tested Flow across my devices and the voice latency feels super crisp today',
  'hey are you free for lunch tomorrow lets do 12 actually no 12:30 if that works for you',
  'um basically quick update for the team we finished the Kubernetes dictionary import and uh all tests are passing now',
  'could you review the pull request before 4 pm and let me know if anything looks off',
];

let mockSampleIndex = 0;

export function getDefaultServerUrl(): string {
  const envUrl =
    typeof import.meta !== 'undefined' && import.meta.env?.VITE_FLOW_API_URL
      ? String(import.meta.env.VITE_FLOW_API_URL).trim()
      : '';
  return (envUrl || LIVE_SEAMLESS_SERVER_URL).replace(/\/+$/, '');
}

export function normalizeBaseUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, '')
    .replace(
      /\/(?:api\/v1\/meetings\/transcribe|api\/|v1\/)?(?:transcribe|health|audio\/transcriptions|inference)$/i,
      ''
    );
}

export function serializeDictionaryForApi(dictionary: DictionaryEntry[]) {
  return dictionary.map((d) =>
    d.type === 'replacement' && d.replacement
      ? { type: 'replacement' as const, trigger: d.trigger, replacement: d.replacement }
      : { type: 'word' as const, trigger: d.trigger }
  );
}

function buildProcessedResult(
  data: Partial<TranscribeResponse>,
  fallbackDurationMs: number,
  language = 'en'
): ProcessedTranscribeResult {
  const formattedText = String(data.formatted_text ?? data.text ?? '').trim();
  const rawText = String(data.raw_text ?? formattedText).trim();
  const finalText = formattedText || rawText;
  const numWords =
    typeof data.num_words === 'number' && data.num_words > 0
      ? data.num_words
      : countWords(finalText);
  const durationMs =
    typeof data.duration_ms === 'number' && data.duration_ms > 0
      ? Math.round(data.duration_ms)
      : Math.max(500, fallbackDurationMs);

  const diff = countStrippedFillersAndCorrections(rawText, finalText);

  return {
    text: finalText,
    formatted_text: finalText,
    raw_text: rawText,
    num_words: numWords,
    language: data.language || language,
    duration_ms: durationMs,
    app_context: data.app_context,
    category: data.category,
    style_applied: data.style_applied,
    packets_received: data.packets_received,
    pcm_bytes_received: data.pcm_bytes_received,
    fillerRemovedCount: Math.max(diff.fillersRemoved, data.filler_removed_count ?? 0),
    correctionsAppliedCount: diff.correctionsFixed,
  };
}

/**
 * Generates a realistic offline demo result when Offline Demo Mode is enabled in Settings,
 * applying the user's active Style preset, Auto Cleanup settings, and Dictionary.
 */
export async function runMockTranscription(
  dictionary: DictionaryEntry[],
  options?: {
    language?: string;
    style?: StylePreset;
    context?: StyleContext;
    cleanup?: AutoCleanupConfig;
    appContext?: string;
  }
): Promise<ProcessedTranscribeResult> {
  await new Promise((resolve) => setTimeout(resolve, 450));
  const rawSample = MOCK_RAW_SAMPLES[mockSampleIndex % MOCK_RAW_SAMPLES.length];
  mockSampleIndex += 1;

  const style = options?.style ?? 'formal';
  const context = options?.context ?? 'other';
  const cleanup = options?.cleanup ?? DEFAULT_CLEANUP_CONFIG;
  const language = options?.language ?? 'en';

  const processed = applyLocalCleanupPipeline(rawSample, {
    style,
    context,
    cleanup,
    dictionary,
  });

  const numWords = Math.max(4, countWords(processed.text));
  const simulatedDurationMs = Math.round((numWords / 168) * 60000);
  const diff = countStrippedFillersAndCorrections(rawSample, processed.text);

  diagnostics.record({
    direction: 'info',
    kind: 'ws_final',
    endpoint: 'offline-demo://local',
    durationMs: simulatedDurationMs,
    summary: `Offline demo transcript (${numWords} words, style=${style})`,
    detail: processed.text,
  });

  return {
    text: processed.text,
    formatted_text: processed.text,
    raw_text: rawSample,
    num_words: numWords,
    language,
    duration_ms: simulatedDurationMs,
    app_context: options?.appContext,
    category: context,
    style_applied: style,
    fillerRemovedCount: Math.max(diff.fillersRemoved, processed.fillerRemovedCount),
    correctionsAppliedCount: Math.max(diff.correctionsFixed, processed.correctionsAppliedCount),
  };
}

/**
 * Verifies backend availability via GET {baseUrl}/health (with fallback to GET {baseUrl}/).
 */
export async function checkServerHealth(config: ApiClientConfig): Promise<ServerHealthResult> {
  const started = performance.now();

  if (config.mockMode) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return {
      ok: true,
      latencyMs: Math.round(performance.now() - started),
      message: 'Offline demo mode active — local cleanup pipeline ready.',
      asrEngine: 'Local Demo',
      vadEngine: 'Browser RMS',
      llmProvider: 'Deterministic',
    };
  }

  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!baseUrl) {
    return { ok: false, latencyMs: 0, message: 'Enter a server link to connect.' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 8000);

  try {
    const headers: Record<string, string> = {};
    if (config.apiKey?.trim()) {
      headers['X-API-Key'] = config.apiKey.trim();
      headers['Authorization'] = `Bearer ${config.apiKey.trim()}`;
    }

    let res = await fetch(`${baseUrl}/health`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    if (res.status === 404) {
      res = await fetch(`${baseUrl}/`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
    }

    const latencyMs = Math.round(performance.now() - started);
    if (!res.ok) {
      const msg =
        res.status === 401 || res.status === 403
          ? 'Server rejected the API key. Check your key and try again.'
          : `Server returned HTTP ${res.status} (${res.statusText || 'Error'}).`;
      diagnostics.record({
        direction: 'in',
        kind: 'error',
        endpoint: `${baseUrl}/health`,
        durationMs: latencyMs,
        summary: `Health check failed (${res.status})`,
        detail: msg,
      });
      return { ok: false, latencyMs, message: msg };
    }

    let asrEngine: string | undefined;
    let vadEngine: string | undefined;
    let llmProvider: string | undefined;
    let availableModels: string[] | undefined;

    try {
      const info = (await res.json()) as {
        status?: string;
        provider?: string;
        model?: string;
        asr_engine?: string;
        layer1_asr?: string;
        vad_engine?: string;
        layer1_vad?: string;
        llm_provider?: string;
        layer2_llm?: string;
        cleanupProvider?: string;
        available_models?: string[];
      };
      asrEngine = info.layer1_asr || info.asr_engine || info.model || info.provider;
      vadEngine = info.layer1_vad || info.vad_engine;
      llmProvider = info.layer2_llm || info.llm_provider || info.cleanupProvider;
      availableModels = Array.isArray(info.available_models) ? info.available_models : undefined;
    } catch {
      // Plain 200 OK health responses are valid
    }

    diagnostics.record({
      direction: 'in',
      kind: 'health',
      endpoint: `${baseUrl}/health`,
      durationMs: latencyMs,
      summary: `Health OK (${latencyMs} ms)`,
      detail: [asrEngine, vadEngine, llmProvider].filter(Boolean).join(' · ') || 'status=ok',
    });

    return {
      ok: true,
      latencyMs,
      message: `Connected (${latencyMs} ms)`,
      asrEngine,
      vadEngine,
      llmProvider,
      availableModels,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    const msg =
      err instanceof DOMException && err.name === 'AbortError'
        ? `Connection timed out after ${Math.round((config.timeoutMs ?? 8000) / 1000)}s. Ensure your server VM is awake.`
        : 'Unable to reach server. Verify the URL is running and HTTPS/CORS is enabled.';
    diagnostics.record({
      direction: 'in',
      kind: 'error',
      endpoint: `${baseUrl}/health`,
      durationMs: latencyMs,
      summary: 'Health check unreachable',
      detail: msg,
    });
    return { ok: false, latencyMs, message: msg };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Live streaming WebSocket client for SeamlessM4T v2 / Faster-Whisper + C++ Silero VAD + Layer 2 LLM:
 * 1. Connects to wss://{host}/api/v1/meetings/transcribe
 * 2. Sends JSON handshake with model, auto-detected app_context, app_category, preset, style_map, cleanup, dictionary
 * 3. Streams 1,024-byte (512-sample = 32ms) 16kHz 16-bit PCM binary ArrayBuffer frames
 * 4. Sends { type: "stop" } and resolves with the server's final JSON payload
 */
export class StreamingDictationSession {
  private ws: WebSocket | null = null;
  private isOpen = false;
  private isClosed = false;
  private isAborted = false;
  private stopSent = false;
  private pendingPackets: ArrayBuffer[] = [];
  private sentPacketCount = 0;
  private sentByteCount = 0;
  private stopSentAt = 0;

  private finalResolve: ((result: ProcessedTranscribeResult) => void) | null = null;
  private finalReject: ((err: Error) => void) | null = null;
  private finalTimeout: ReturnType<typeof setTimeout> | null = null;
  private fallbackDurationMs = 1000;

  private readonly wsUrl: string;
  private readonly displayUrl: string;
  private readonly handshakePayload: {
    type: 'start';
    model?: string;
    preset: StylePreset;
    app_context: string;
    app_category: StyleContext;
    style_map: StylesByContext;
    cleanup: AutoCleanupConfig;
    dictionary: ReturnType<typeof serializeDictionaryForApi>;
  };

  constructor(options: {
    baseUrl: string;
    model?: AsrModelOption;
    appContext: string;
    appCategory: StyleContext;
    preset: StylePreset;
    styleMap: StylesByContext;
    cleanup: AutoCleanupConfig;
    dictionary: DictionaryEntry[];
    apiKey?: string;
  }) {
    const url = deriveWebSocketUrl(options.baseUrl);
    this.displayUrl = url;
    if (options.apiKey?.trim()) {
      const sep = url.includes('?') ? '&' : '?';
      this.wsUrl = `${url}${sep}api_key=${encodeURIComponent(options.apiKey.trim())}`;
    } else {
      this.wsUrl = url;
    }

    this.handshakePayload = {
      type: 'start',
      model: options.model && options.model !== 'auto' ? options.model : undefined,
      preset: options.preset,
      app_context: options.appContext,
      app_category: options.appCategory,
      style_map: options.styleMap,
      cleanup: options.cleanup,
      dictionary: serializeDictionaryForApi(options.dictionary),
    };
  }

  get packetsSent(): number {
    return this.sentPacketCount;
  }

  get bytesSent(): number {
    return this.sentByteCount;
  }

  connect(): void {
    diagnostics.startSession(this.displayUrl);
    diagnostics.record({
      direction: 'info',
      kind: 'ws_connect',
      endpoint: this.displayUrl,
      summary: 'Opening WebSocket audio stream',
      detail: `model=${this.handshakePayload.model ?? 'auto'} · app=${this.handshakePayload.app_context} · style=${this.handshakePayload.preset}`,
    });

    const ws = new WebSocket(this.wsUrl);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      if (this.isAborted) {
        ws.close();
        return;
      }
      this.isOpen = true;
      const startJson = JSON.stringify(this.handshakePayload);
      ws.send(startJson);

      diagnostics.record({
        direction: 'out',
        kind: 'ws_handshake',
        endpoint: this.displayUrl,
        bytes: startJson.length,
        summary: 'Sent JSON handshake { type: "start" }',
        detail: `app=${this.handshakePayload.app_context} (${this.handshakePayload.app_category}), preset=${this.handshakePayload.preset}, model=${this.handshakePayload.model ?? 'auto'}, dict=${this.handshakePayload.dictionary.length}`,
      });

      for (const packet of this.pendingPackets) {
        if (ws.readyState === WebSocket.OPEN) {
          this.transmitBinaryPacket(ws, packet);
        }
      }
      this.pendingPackets = [];

      if (this.stopSent && ws.readyState === WebSocket.OPEN) {
        this.sendStopFrame(ws);
      }
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      try {
        const msg = JSON.parse(event.data) as Partial<TranscribeResponse> & {
          error?: string;
          message?: string;
        };

        if (msg.status === 'ready') {
          diagnostics.record({
            direction: 'in',
            kind: 'ws_ready',
            endpoint: this.displayUrl,
            summary: 'Server acknowledged { status: "ready" }',
            detail: 'Ready to receive 1,024-byte (32 ms) 16 kHz Int16 PCM frames',
          });
          return;
        }

        if (msg.status === 'error' || msg.error) {
          const errMsg = msg.error || msg.message || 'Transcription server returned an error.';
          diagnostics.record({
            direction: 'in',
            kind: 'error',
            endpoint: this.displayUrl,
            summary: 'Server returned stream error',
            detail: errMsg,
          });
          this.rejectFinal(new Error(errMsg));
          return;
        }

        const hasTranscript =
          typeof msg.formatted_text === 'string' || typeof msg.text === 'string';
        if (msg.is_final === true || (this.stopSent && hasTranscript)) {
          const rttMs = this.stopSentAt > 0 ? Math.round(performance.now() - this.stopSentAt) : null;
          const result = buildProcessedResult(msg, this.fallbackDurationMs);
          diagnostics.updateStats({
            activeSessionStatus: 'completed',
            lastRoundTripMs: rttMs,
            lastServerAckPackets:
              typeof msg.packets_received === 'number' ? msg.packets_received : null,
            lastServerAckBytes:
              typeof msg.pcm_bytes_received === 'number' ? msg.pcm_bytes_received : null,
          });
          diagnostics.record({
            direction: 'in',
            kind: 'ws_final',
            endpoint: this.displayUrl,
            durationMs: rttMs ?? undefined,
            summary: `Received final transcript (${result.num_words} words${
              typeof msg.packets_received === 'number'
                ? `, server ack ${msg.packets_received} pkts / ${msg.pcm_bytes_received ?? 0} B`
                : ''
            })`,
            detail: result.formatted_text || '(empty speech)',
          });
          this.resolveFinal(result);
        }
      } catch {
        // Ignore non-JSON keepalive frames
      }
    };

    ws.onerror = () => {
      diagnostics.updateStats({ activeSessionStatus: 'error' });
      diagnostics.record({
        direction: 'in',
        kind: 'error',
        endpoint: this.displayUrl,
        summary: 'WebSocket connection error',
        detail: 'Check that the server is running and supports WebSocket upgrades on /api/v1/meetings/transcribe',
      });
      if (!this.isAborted && this.finalReject) {
        this.rejectFinal(new Error('WebSocket connection error while streaming audio to server.'));
      }
    };

    ws.onclose = (ev) => {
      this.isClosed = true;
      this.isOpen = false;
      if (!this.isAborted && this.finalReject) {
        const reason = ev.reason ? ` (${ev.reason})` : '';
        diagnostics.updateStats({ activeSessionStatus: 'error' });
        this.rejectFinal(
          new Error(`Transcription stream closed before returning final text${reason}.`)
        );
      }
    };
  }

  private transmitBinaryPacket(ws: WebSocket, packet: ArrayBuffer): void {
    ws.send(packet);
    this.sentPacketCount += 1;
    this.sentByteCount += packet.byteLength;
    const rms = computePcmPacketRms(packet);
    diagnostics.record({
      direction: 'out',
      kind: 'pcm_chunk',
      endpoint: this.displayUrl,
      bytes: packet.byteLength,
      durationMs: Math.round((packet.byteLength / 2 / TARGET_SAMPLE_RATE) * 1000),
      packetSeq: this.sentPacketCount,
      summary: `PCM chunk #${this.sentPacketCount} (${packet.byteLength} B · 32 ms @ 16 kHz)`,
      detail: `rms=${rms.toFixed(4)} · buffered=${ws.bufferedAmount} B · total=${this.sentByteCount} B`,
      hexPreview: formatPacketHexPreview(packet, 12),
    });
  }

  private sendStopFrame(ws: WebSocket): void {
    this.stopSentAt = performance.now();
    const stopPayload = JSON.stringify({
      type: 'stop',
      packets_sent: this.sentPacketCount,
      bytes_sent: this.sentByteCount,
    });
    ws.send(stopPayload);
    diagnostics.updateStats({ activeSessionStatus: 'awaiting_final' });
    diagnostics.record({
      direction: 'out',
      kind: 'ws_stop',
      endpoint: this.displayUrl,
      bytes: stopPayload.length,
      summary: `Sent { type: "stop" } after ${this.sentPacketCount} × 32ms chunks (${this.sentByteCount.toLocaleString()} B)`,
      detail: stopPayload,
    });
  }

  sendPcmPacket(packet: ArrayBuffer): void {
    if (this.isAborted || this.isClosed || this.stopSent) return;
    if (this.isOpen && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.transmitBinaryPacket(this.ws, packet);
    } else if (this.pendingPackets.length < 400) {
      this.pendingPackets.push(packet);
    }
  }

  finish(fallbackDurationMs: number, timeoutMs = 30000): Promise<ProcessedTranscribeResult> {
    this.fallbackDurationMs = Math.max(400, fallbackDurationMs);
    this.stopSent = true;

    return new Promise<ProcessedTranscribeResult>((resolve, reject) => {
      if (this.isAborted) {
        reject(new Error('Dictation was cancelled.'));
        return;
      }

      if (!this.ws || this.isClosed) {
        reject(new Error('WebSocket is not connected to transcription server.'));
        return;
      }

      this.finalResolve = resolve;
      this.finalReject = reject;

      this.finalTimeout = setTimeout(() => {
        this.rejectFinal(
          new Error(
            `Timed out waiting for polished transcript after ${Math.round(timeoutMs / 1000)}s.`
          )
        );
      }, timeoutMs);

      if (this.isOpen && this.ws.readyState === WebSocket.OPEN) {
        this.sendStopFrame(this.ws);
      }
    });
  }

  abort(): void {
    this.isAborted = true;
    this.pendingPackets = [];
    if (this.finalTimeout) {
      clearTimeout(this.finalTimeout);
      this.finalTimeout = null;
    }
    this.finalResolve = null;
    this.finalReject = null;
    diagnostics.updateStats({ activeSessionStatus: 'idle' });
    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        this.ws.close();
      } catch {
        // Ignore close error
      }
      this.ws = null;
    }
  }

  private resolveFinal(result: ProcessedTranscribeResult): void {
    if (this.finalTimeout) {
      clearTimeout(this.finalTimeout);
      this.finalTimeout = null;
    }
    const resolve = this.finalResolve;
    this.finalResolve = null;
    this.finalReject = null;
    try {
      this.ws?.close(1000, 'complete');
    } catch {
      // Ignore
    }
    resolve?.(result);
  }

  private rejectFinal(err: Error): void {
    if (this.finalTimeout) {
      clearTimeout(this.finalTimeout);
      this.finalTimeout = null;
    }
    const reject = this.finalReject;
    this.finalResolve = null;
    this.finalReject = null;
    try {
      this.ws?.close();
    } catch {
      // Ignore
    }
    reject?.(err);
  }
}

/**
 * Runs a real synthetic 32ms-packet WebSocket connectivity verification against the given baseUrl.
 * Sends the JSON `start` handshake, five 1,024-byte (512-sample = 32ms) Int16 PCM packets, and `stop`,
 * verifying end-to-end packet splitting, binary transmission, and backend acknowledgment.
 */
export async function runLiveStreamDiagnosticTest(options: {
  baseUrl: string;
  apiKey?: string;
  model?: AsrModelOption;
  dictionary: DictionaryEntry[];
  styleMap: StylesByContext;
}): Promise<{
  ok: boolean;
  packetsSent: number;
  bytesSent: number;
  serverAckPackets: number | null;
  serverAckBytes: number | null;
  roundTripMs: number;
  message: string;
}> {
  const started = performance.now();
  const session = new StreamingDictationSession({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    model: options.model,
    appContext: 'Diagnostics',
    appCategory: 'work',
    preset: options.styleMap.work ?? 'casual',
    styleMap: options.styleMap,
    cleanup: DEFAULT_CLEANUP_CONFIG,
    dictionary: options.dictionary,
  });

  try {
    session.connect();

    // Generate 160ms (5 x 32ms = 2,560 samples) of low-amplitude 440 Hz PCM and split with PcmPacketizer
    const samples = new Int16Array(PCM_PACKET_SAMPLES * 5);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / TARGET_SAMPLE_RATE) * 800);
    }

    const packetizer = new PcmPacketizer(PCM_PACKET_SAMPLES);
    const packets = packetizer.push(samples);
    for (const pkt of packets) {
      session.sendPcmPacket(pkt);
      await new Promise((r) => setTimeout(r, 32));
    }

    const result = await session.finish(160, 12000);
    const rtt = Math.round(performance.now() - started);
    return {
      ok: true,
      packetsSent: packets.length,
      bytesSent: packets.length * PCM_PACKET_BYTES,
      serverAckPackets: result.packets_received ?? null,
      serverAckBytes: result.pcm_bytes_received ?? null,
      roundTripMs: rtt,
      message:
        typeof result.packets_received === 'number'
          ? `Verified ${packets.length} × 32ms chunks (${packets.length * PCM_PACKET_BYTES} B) acknowledged by backend.`
          : `Streamed ${packets.length} × 32ms chunks (${packets.length * PCM_PACKET_BYTES} B) cleanly in ${rtt} ms.`,
    };
  } catch (err) {
    session.abort();
    const rtt = Math.round(performance.now() - started);
    return {
      ok: false,
      packetsSent: 0,
      bytesSent: 0,
      serverAckPackets: null,
      serverAckBytes: null,
      roundTripMs: rtt,
      message: err instanceof Error ? err.message : 'Stream verification failed',
    };
  }
}

/**
 * Batch Transcribe / Re-transcribe endpoint:
 * POST {baseUrl}/transcribe with multipart FormData:
 *   audio, model, style, context, app_context, cleanup, dictionary, language
 */
export async function batchTranscribeAudio(
  payload: BatchTranscribePayload,
  config: ApiClientConfig
): Promise<ProcessedTranscribeResult> {
  const language = payload.language ?? 'en';

  if (config.mockMode) {
    return runMockTranscription(payload.dictionary, {
      language,
      style: payload.style,
      context: payload.context,
      cleanup: payload.cleanup,
      appContext: payload.appContext,
    });
  }

  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!baseUrl) {
    throw new Error('Server URL is not configured. Open Settings to paste your server link.');
  }

  const formData = new FormData();
  formData.append('audio', payload.audio, payload.filename ?? 'retranscribe.webm');
  if (payload.model && payload.model !== 'auto') {
    formData.append('model', payload.model);
  }
  formData.append('style', payload.style || 'formal');
  formData.append('context', payload.context || 'other');
  if (payload.appContext) {
    formData.append('app_context', payload.appContext);
  }
  formData.append('cleanup', JSON.stringify(payload.cleanup ?? DEFAULT_CLEANUP_CONFIG));
  formData.append('dictionary', JSON.stringify(serializeDictionaryForApi(payload.dictionary)));
  formData.append('language', language);

  const headers: Record<string, string> = {};
  if (config.apiKey?.trim()) {
    headers['X-API-Key'] = config.apiKey.trim();
    headers['Authorization'] = `Bearer ${config.apiKey.trim()}`;
  }

  const endpoint = `${baseUrl}/transcribe`;
  diagnostics.record({
    direction: 'out',
    kind: 'http_batch',
    endpoint,
    bytes: payload.audio.size,
    summary: `POST /transcribe (${payload.audio.size.toLocaleString()} B)`,
    detail: `style=${payload.style || 'formal'} · app=${payload.appContext || 'unknown'} · model=${payload.model || 'auto'}`,
  });

  const controller = new AbortController();
  const timeoutMs = config.timeoutMs ?? 30000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: formData,
      signal: controller.signal,
    });

    const elapsedMs = Math.round(performance.now() - started);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(
        `Server error (${response.status}): ${errorBody.slice(0, 140) || response.statusText}`
      );
    }

    const data = (await response.json()) as Partial<TranscribeResponse>;
    const processed = buildProcessedResult(data, 3000, language);
    diagnostics.record({
      direction: 'in',
      kind: 'http_batch',
      endpoint,
      durationMs: elapsedMs,
      summary: `Batch response (${processed.num_words} words in ${elapsedMs} ms)`,
      detail: processed.formatted_text,
    });
    return processed;
  } catch (err) {
    const msg =
      err instanceof DOMException && err.name === 'AbortError'
        ? `Transcription timed out after ${Math.round(timeoutMs / 1000)}s.`
        : err instanceof TypeError
          ? `Network error reaching ${endpoint}.`
          : err instanceof Error
            ? err.message
            : 'Batch transcription error';
    diagnostics.record({
      direction: 'in',
      kind: 'error',
      endpoint,
      summary: 'Batch POST /transcribe failed',
      detail: msg,
    });
    if (err instanceof DOMException || err instanceof TypeError) {
      throw new Error(msg);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
