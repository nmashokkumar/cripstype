export type NavPage = 'dictation' | 'insights' | 'dictionary' | 'style' | 'diagnostics';

export type StyleContext = 'personal' | 'work' | 'email' | 'other';
export type StylePreset = 'standard' | 'formal' | 'casual' | 'very_casual';

export type StylesByContext = Record<StyleContext, StylePreset>;

export type DictationMode = 'push_to_talk' | 'hands_free';

export type DictationOverlayState = 'idle' | 'listening' | 'transcribing' | 'done' | 'error';

export type DictationStage = 'record' | 'transcribe' | 'cleanup' | 'polish';

export type AsrModelOption =
  | 'auto'
  | 'seamless-m4t-v2'
  | 'faster-whisper-distil-large-v3'
  | 'faster-whisper-large-v3-turbo';

export interface AutoCleanupConfig {
  removeFillerWords: boolean;
  applySelfCorrections: boolean;
  autoPunctuation: boolean;
  autoCapitalization: boolean;
}

export interface DictionaryEntry {
  id: string;
  type: 'word' | 'replacement';
  /** Plain word to spell accurately, or the spoken trigger for a replacement */
  trigger: string;
  /** Target replacement phrase (only used when type === 'replacement') */
  replacement?: string;
  starred: boolean;
  scope: 'personal';
  createdAt: number;
}

export interface HistoryEntry {
  id: string;
  text: string;
  rawText: string;
  audioBlob?: Blob | null;
  numWords?: number;
  durationMs: number;
  timestamp: number;
  styleUsed?: StylePreset;
  contextUsed?: StyleContext;
  /** System-detected active application at the time of dictation (read-only) */
  appTag: string;
  flagged: boolean;
  fillerRemovedCount: number;
  correctionsAppliedCount: number;
  language: string;
}

export interface HotkeyBinding {
  code: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
  label: string;
}

export interface AppSettings {
  serverUrl: string;
  apiKey: string;
  asrModel: AsrModelOption;
  pushToTalkHotkey: HotkeyBinding;
  handsFreeHotkey: HotkeyBinding;
  dictationMode: DictationMode;
  micDeviceId: string;
  silenceTimeoutSec: number;
  mockMode: boolean;
  theme: 'light' | 'dark';
}

export interface TranscribeResponse {
  status?: string;
  text: string;
  formatted_text?: string;
  raw_text: string;
  num_words?: number;
  language?: string;
  duration_ms: number;
  app_context?: string;
  category?: StyleContext;
  style_applied?: StylePreset;
  packets_received?: number;
  pcm_bytes_received?: number;
  filler_removed_count?: number;
  layer2_latency_ms?: number;
  is_final?: boolean;
}

export interface PipelineTransformResult {
  text: string;
  fillerRemovedCount: number;
  correctionsAppliedCount: number;
  dictionaryAppliedCount: number;
}

export interface ToastMessage {
  id: string;
  message: string;
  tone: 'default' | 'success' | 'error';
}
