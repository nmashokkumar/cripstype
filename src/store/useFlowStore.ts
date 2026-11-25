import { create } from 'zustand';
import type {
  AppSettings,
  AutoCleanupConfig,
  DictionaryEntry,
  DictationMode,
  DictationOverlayState,
  DictationStage,
  HistoryEntry,
  NavPage,
  StyleContext,
  StylePreset,
  StylesByContext,
  ToastMessage,
} from '../types';
import {
  DEFAULT_DICTIONARY_ENTRIES,
  bulkSaveDictionaryEntriesDb,
  clearAllHistory,
  deleteDictionaryEntryDb,
  deleteHistoryEntry,
  getHistoryEntryById,
  loadAllDictionary,
  loadAllHistory,
  saveDictionaryEntryDb,
  saveHistoryEntry,
} from '../services/db';
import {
  DEFAULT_CLEANUP_CONFIG,
  LIVE_SEAMLESS_SERVER_URL,
  StreamingDictationSession,
  batchTranscribeAudio,
  getDefaultServerUrl,
  runMockTranscription,
} from '../services/api';
import {
  AudioCaptureController,
  MAX_MONOLOGUE_DURATION_MS,
  playCompletionChime,
} from '../services/audio';
import { DEFAULT_HANDS_FREE_HOTKEY, DEFAULT_PTT_HOTKEY } from '../services/hotkeys';
import { platform } from '../services/platform';
import {
  DEFAULT_STYLES_BY_CONTEXT,
  classifyAppContext,
  resolveStylePresetForCategory,
  type DetectedAppContext,
} from '../utils/appClassifier';
import {
  applyLocalCleanupPipeline,
  countStrippedFillersAndCorrections,
  countWords,
} from '../utils/textPipeline';

const SETTINGS_KEY = 'flow_settings_v1';
const SETTINGS_MIGRATION_V2_KEY = 'flow_settings_seamless_v2';
const STYLES_KEY = 'flow_styles_v1';
const DISMISSED_KEY = 'flow_dismissed_v1';

const DEFAULT_SETTINGS: AppSettings = {
  serverUrl: getDefaultServerUrl(),
  apiKey: '',
  asrModel: 'auto',
  pushToTalkHotkey: DEFAULT_PTT_HOTKEY,
  handsFreeHotkey: DEFAULT_HANDS_FREE_HOTKEY,
  dictationMode: 'push_to_talk',
  micDeviceId: 'default',
  silenceTimeoutSec: 5,
  mockMode: false,
  launchAtStartup: true,
  minimizeToTray: true,
  theme: 'light',
};

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...JSON.parse(raw) };
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota errors
  }
}

const audioController = new AudioCaptureController();
let activeWsSession: StreamingDictationSession | null = null;
let activeDetectedApp: DetectedAppContext = { appName: 'Browser', category: 'other' };
let activeStartNonce = 0;
let pendingStopDuringStart = false;
let doneResetTimer: ReturnType<typeof setTimeout> | null = null;
let errorResetTimer: ReturnType<typeof setTimeout> | null = null;

// BroadcastChannel so /overlay route stays synced in multi-window Electron/Tauri wrappers
const overlayChannel =
  typeof window !== 'undefined' && 'BroadcastChannel' in window
    ? new BroadcastChannel('flow-overlay-sync')
    : null;

function isOverlayWindowContext(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.pathname.replace(/\/+$/, '') === '/overlay';
}

export type OverlayCommandAction = 'stop' | 'cancel' | 'clearError';

/**
 * Relays user clicks inside the standalone /overlay floating window (e.g. clicking ✓
 * or dismissing an error) back to the main hidden/tray window that owns the mic stream.
 */
export function sendOverlayCommand(action: OverlayCommandAction): void {
  overlayChannel?.postMessage({ type: 'command', action });
  const tauriEmit = typeof window !== 'undefined' ? window.__TAURI__?.event?.emit : undefined;
  if (typeof tauriEmit === 'function') {
    void tauriEmit('crisptype:overlay-command', { action }).catch(() => undefined);
  }
}

interface DismissedBanners {
  dictationTips: boolean;
  dictionaryBanner: boolean;
  styleBanner: boolean;
}

export interface LastDictationPreview {
  text: string;
  rawText: string;
  appName: string;
  styleUsed: StylePreset;
  fillerRemovedCount: number;
  correctionsAppliedCount: number;
  timestamp: number;
}

interface FlowState {
  activePage: NavPage;
  sidebarCollapsed: boolean;
  settingsOpen: boolean;
  isCapturingHotkey: boolean;

  settings: AppSettings;
  stylesByContext: StylesByContext;
  cleanupConfig: AutoCleanupConfig;
  dictionary: DictionaryEntry[];
  dictionaryLoaded: boolean;
  dismissed: DismissedBanners;

  history: HistoryEntry[];
  historyLoaded: boolean;
  retranscribingId: string | null;

  // Live dictation engine state
  overlayState: DictationOverlayState;
  activeStage: DictationStage;
  activeRecordingMode: DictationMode | null;
  recordingElapsedMs: number;
  audioLevels: number[];
  overlayError: string | null;
  lastResult: LastDictationPreview | null;
  testInputText: string;

  toasts: ToastMessage[];

  // Navigation & UI
  setActivePage: (page: NavPage) => void;
  toggleSidebar: () => void;
  setSettingsOpen: (open: boolean) => void;
  setIsCapturingHotkey: (capturing: boolean) => void;

  // Settings & Style preferences
  updateSettings: (partial: Partial<AppSettings>) => void;
  toggleTheme: () => void;
  setDictationMode: (mode: DictationMode) => void;
  setStylePreset: (context: StyleContext, preset: StylePreset) => void;
  dismissBanner: (key: keyof DismissedBanners) => void;

  // Dictionary CRUD (persisted in IndexedDB)
  initDictionary: () => Promise<void>;
  addDictionaryEntry: (entry: Omit<DictionaryEntry, 'id' | 'createdAt' | 'scope'>) => void;
  updateDictionaryEntry: (id: string, updates: Partial<Omit<DictionaryEntry, 'id'>>) => void;
  deleteDictionaryEntry: (id: string) => void;
  toggleStarDictionaryEntry: (id: string) => void;
  importDictionaryEntries: (
    entries: Array<Omit<DictionaryEntry, 'id' | 'createdAt' | 'scope'>>
  ) => number;

  // History CRUD (persisted in IndexedDB)
  initHistory: () => Promise<void>;
  toggleFlagHistory: (id: string) => Promise<void>;
  deleteHistory: (id: string) => Promise<void>;
  retranscribeHistory: (id: string) => Promise<void>;
  clearHistory: () => Promise<void>;

  // Dictation engine
  startDictation: (overrideMode?: DictationMode) => Promise<void>;
  stopDictation: () => Promise<void>;
  cancelDictation: () => void;
  clearOverlayError: () => void;
  setTestInputText: (value: string) => void;
  appendTestInputText: (value: string) => void;

  // Toasts
  pushToast: (message: string, tone?: ToastMessage['tone']) => void;
  dismissToast: (id: string) => void;
}

function loadInitialSettings(): AppSettings {
  const raw = readJson<Partial<AppSettings>>(SETTINGS_KEY, DEFAULT_SETTINGS);
  let serverUrl = raw.serverUrl || getDefaultServerUrl();
  let silenceTimeoutSec =
    typeof raw.silenceTimeoutSec === 'number' ? raw.silenceTimeoutSec : 5;

  if (typeof window !== 'undefined' && !window.localStorage.getItem(SETTINGS_MIGRATION_V2_KEY)) {
    const looksLikeOldDefault =
      !serverUrl ||
      serverUrl === 'http://localhost:8000' ||
      serverUrl === 'http://localhost:3000' ||
      serverUrl === window.location.origin;
    if (looksLikeOldDefault) {
      serverUrl = LIVE_SEAMLESS_SERVER_URL;
    }
    if (silenceTimeoutSec === 3) {
      silenceTimeoutSec = 5;
    }
    window.localStorage.setItem(SETTINGS_MIGRATION_V2_KEY, '1');
  }

  const normalized: AppSettings = {
    serverUrl,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    asrModel: 'auto',
    pushToTalkHotkey: raw.pushToTalkHotkey?.code ? raw.pushToTalkHotkey : DEFAULT_PTT_HOTKEY,
    handsFreeHotkey: raw.handsFreeHotkey?.code ? raw.handsFreeHotkey : DEFAULT_HANDS_FREE_HOTKEY,
    dictationMode: raw.dictationMode === 'hands_free' ? 'hands_free' : 'push_to_talk',
    micDeviceId: typeof raw.micDeviceId === 'string' ? raw.micDeviceId : 'default',
    silenceTimeoutSec,
    mockMode: false,
    launchAtStartup: typeof raw.launchAtStartup === 'boolean' ? raw.launchAtStartup : true,
    minimizeToTray: typeof raw.minimizeToTray === 'boolean' ? raw.minimizeToTray : true,
    theme: raw.theme === 'dark' ? 'dark' : 'light',
  };

  writeJson(SETTINGS_KEY, normalized);
  return normalized;
}

const initialSettings = loadInitialSettings();

export const useFlowStore = create<FlowState>((set, get) => {
  const broadcastOverlay = () => {
    const s = get();
    const shouldAllowClicks =
      (s.overlayState === 'listening' &&
        (s.activeRecordingMode ?? s.settings.dictationMode) === 'hands_free') ||
      s.overlayState === 'error';

    if (!isOverlayWindowContext()) {
      platform.setOverlayVisible(s.overlayState !== 'idle');
    }
    platform.setOverlayInteractive(shouldAllowClicks);

    const payload = {
      type: 'state' as const,
      overlayState: s.overlayState,
      activeStage: s.activeStage,
      activeRecordingMode: s.activeRecordingMode,
      recordingElapsedMs: s.recordingElapsedMs,
      audioLevels: s.audioLevels,
      overlayError: s.overlayError,
    };

    overlayChannel?.postMessage(payload);
    const tauriEmit = typeof window !== 'undefined' ? window.__TAURI__?.event?.emit : undefined;
    if (!isOverlayWindowContext() && typeof tauriEmit === 'function') {
      void tauriEmit('crisptype:overlay-state', payload).catch(() => undefined);
    }
  };

  const applyRemoteOverlayMessage = (msg: Record<string, unknown>) => {
    if (msg.type === 'state') {
      set({
        overlayState: msg.overlayState as DictationOverlayState,
        activeStage: (msg.activeStage as DictationStage) ?? 'record',
        activeRecordingMode: (msg.activeRecordingMode as DictationMode | null) ?? null,
        recordingElapsedMs: typeof msg.recordingElapsedMs === 'number' ? msg.recordingElapsedMs : 0,
        audioLevels: Array.isArray(msg.audioLevels) ? (msg.audioLevels as number[]) : Array(10).fill(0.18),
        overlayError: typeof msg.overlayError === 'string' ? msg.overlayError : null,
      });
      return;
    }
    if (msg.type === 'command' && !isOverlayWindowContext()) {
      if (msg.action === 'stop') {
        void get().stopDictation();
      } else if (msg.action === 'cancel') {
        get().cancelDictation();
      } else if (msg.action === 'clearError') {
        get().clearOverlayError();
      }
    }
  };

  if (overlayChannel) {
    overlayChannel.onmessage = (event) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;
      applyRemoteOverlayMessage(msg as Record<string, unknown>);
    };
  }

  // Also bridge Tauri cross-window events so main <-> overlay stay synced across isolated webviews
  if (typeof window !== 'undefined' && typeof window.__TAURI__?.event?.listen === 'function') {
    const listen = window.__TAURI__.event.listen;
    if (isOverlayWindowContext()) {
      void listen<Record<string, unknown>>('crisptype:overlay-state', (ev) => {
        if (ev.payload && typeof ev.payload === 'object') {
          applyRemoteOverlayMessage(ev.payload);
        }
      }).catch(() => undefined);
    } else {
      void listen<{ action?: OverlayCommandAction }>('crisptype:overlay-command', (ev) => {
        if (ev.payload?.action) {
          applyRemoteOverlayMessage({ type: 'command', action: ev.payload.action });
        }
      }).catch(() => undefined);
    }
  }

  return {
    activePage: 'dictation',
    sidebarCollapsed: false,
    settingsOpen: false,
    isCapturingHotkey: false,

    settings: initialSettings,
    stylesByContext: readJson<StylesByContext>(STYLES_KEY, DEFAULT_STYLES_BY_CONTEXT),
    cleanupConfig: DEFAULT_CLEANUP_CONFIG,
    dictionary: DEFAULT_DICTIONARY_ENTRIES,
    dictionaryLoaded: false,
    dismissed: readJson<DismissedBanners>(DISMISSED_KEY, {
      dictationTips: false,
      dictionaryBanner: false,
      styleBanner: false,
    }),

    history: [],
    historyLoaded: false,
    retranscribingId: null,

    overlayState: 'idle',
    activeStage: 'record',
    activeRecordingMode: null,
    recordingElapsedMs: 0,
    audioLevels: Array(10).fill(0.18),
    overlayError: null,
    lastResult: null,
    testInputText: '',

    toasts: [],

    setActivePage: (activePage) => set({ activePage }),
    toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
    setSettingsOpen: (settingsOpen) => set({ settingsOpen, isCapturingHotkey: false }),
    setIsCapturingHotkey: (isCapturingHotkey) => set({ isCapturingHotkey }),

    updateSettings: (partial) =>
      set((state) => {
        const next = { ...state.settings, ...partial, mockMode: false };
        writeJson(SETTINGS_KEY, next);
        if (
          partial.micDeviceId !== undefined &&
          partial.micDeviceId !== state.settings.micDeviceId
        ) {
          audioController.releaseWarmPipeline();
        }
        if (partial.pushToTalkHotkey || partial.handsFreeHotkey) {
          platform.syncNativeHotkeys({
            pushToTalk: next.pushToTalkHotkey,
            handsFree: next.handsFreeHotkey,
          });
        }
        if (
          partial.launchAtStartup !== undefined &&
          partial.launchAtStartup !== state.settings.launchAtStartup
        ) {
          void platform.setAutoStart(next.launchAtStartup);
        }
        if (
          partial.minimizeToTray !== undefined &&
          partial.minimizeToTray !== state.settings.minimizeToTray
        ) {
          void platform.setMinimizeToTray(next.minimizeToTray);
        }
        return { settings: next };
      }),

    toggleTheme: () => {
      const current = get().settings.theme;
      get().updateSettings({ theme: current === 'light' ? 'dark' : 'light' });
    },

    setDictationMode: (dictationMode) => {
      get().updateSettings({ dictationMode });
      get().pushToast(
        dictationMode === 'push_to_talk' ? 'Switched to Push-to-talk mode' : 'Switched to Hands-free mode'
      );
      broadcastOverlay();
    },

    setStylePreset: (context, preset) =>
      set((state) => {
        const next = { ...state.stylesByContext, [context]: preset };
        writeJson(STYLES_KEY, next);
        return { stylesByContext: next };
      }),

    dismissBanner: (key) =>
      set((state) => {
        const next = { ...state.dismissed, [key]: true };
        writeJson(DISMISSED_KEY, next);
        return { dismissed: next };
      }),

    initDictionary: async () => {
      try {
        const items = await loadAllDictionary();
        set({ dictionary: items, dictionaryLoaded: true });
      } catch {
        set({ dictionaryLoaded: true });
      }
    },

    addDictionaryEntry: (entry) => {
      const cleanTrigger = entry.trigger.trim();
      if (!cleanTrigger) return;
      const exists = get().dictionary.some(
        (d) => d.trigger.toLowerCase() === cleanTrigger.toLowerCase()
      );
      if (exists) {
        get().pushToast(`"${cleanTrigger}" is already in your dictionary`, 'error');
        return;
      }
      const nextEntry: DictionaryEntry = {
        id: `dict-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: entry.type,
        trigger: cleanTrigger,
        replacement: entry.type === 'replacement' ? entry.replacement?.trim() : undefined,
        starred: entry.starred,
        scope: 'personal',
        createdAt: Date.now(),
      };
      set((state) => ({ dictionary: [nextEntry, ...state.dictionary] }));
      void saveDictionaryEntryDb(nextEntry);
    },

    updateDictionaryEntry: (id, updates) => {
      let updatedItem: DictionaryEntry | null = null;
      set((state) => {
        const next = state.dictionary.map((item) => {
          if (item.id !== id) return item;
          updatedItem = {
            ...item,
            ...updates,
            trigger: updates.trigger !== undefined ? updates.trigger.trim() : item.trigger,
            replacement:
              updates.type === 'word'
                ? undefined
                : updates.replacement !== undefined
                  ? updates.replacement.trim()
                  : item.replacement,
          };
          return updatedItem;
        });
        return { dictionary: next };
      });
      if (updatedItem) {
        void saveDictionaryEntryDb(updatedItem);
      }
    },

    deleteDictionaryEntry: (id) => {
      set((state) => ({
        dictionary: state.dictionary.filter((item) => item.id !== id),
      }));
      void deleteDictionaryEntryDb(id);
    },

    toggleStarDictionaryEntry: (id) => {
      let toggled: DictionaryEntry | null = null;
      set((state) => {
        const next = state.dictionary.map((item) => {
          if (item.id !== id) return item;
          toggled = { ...item, starred: !item.starred };
          return toggled;
        });
        return { dictionary: next };
      });
      if (toggled) {
        void saveDictionaryEntryDb(toggled);
      }
    },

    importDictionaryEntries: (entries) => {
      const additions: DictionaryEntry[] = [];
      set((state) => {
        const existingTriggers = new Set(state.dictionary.map((d) => d.trigger.toLowerCase()));
        for (const item of entries) {
          const trig = item.trigger.trim();
          if (!trig || existingTriggers.has(trig.toLowerCase())) continue;
          existingTriggers.add(trig.toLowerCase());
          additions.push({
            id: `dict-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            type: item.type,
            trigger: trig,
            replacement: item.type === 'replacement' ? item.replacement?.trim() : undefined,
            starred: item.starred,
            scope: 'personal',
            createdAt: Date.now() + additions.length,
          });
        }
        return { dictionary: [...additions, ...state.dictionary] };
      });
      if (additions.length > 0) {
        void bulkSaveDictionaryEntriesDb(additions);
      }
      return additions.length;
    },

    initHistory: async () => {
      try {
        const items = await loadAllHistory();
        set({ history: items, historyLoaded: true });
      } catch {
        set({ historyLoaded: true });
      }
    },

    toggleFlagHistory: async (id) => {
      const target = get().history.find((h) => h.id === id);
      if (!target) return;
      const updated: HistoryEntry = { ...target, flagged: !target.flagged };
      await saveHistoryEntry(updated);
      set((s) => ({
        history: s.history.map((h) => (h.id === id ? updated : h)),
      }));
    },

    deleteHistory: async (id) => {
      await deleteHistoryEntry(id);
      set((s) => ({
        history: s.history.filter((h) => h.id !== id),
      }));
      get().pushToast('Dictation deleted');
    },

    retranscribeHistory: async (id) => {
      const state = get();
      const storedEntry = (await getHistoryEntryById(id)) ?? state.history.find((h) => h.id === id);
      if (!storedEntry) return;

      const detected = classifyAppContext(storedEntry.appTag);
      const context = storedEntry.contextUsed ?? detected.category;
      const preset = resolveStylePresetForCategory(context, state.stylesByContext);

      set({ retranscribingId: id });
      try {
        let updated: HistoryEntry;

        if (storedEntry.audioBlob && storedEntry.audioBlob.size > 32 && !state.settings.mockMode) {
          set({ overlayState: 'transcribing', activeStage: 'polish', overlayError: null });
          broadcastOverlay();

          const result = await batchTranscribeAudio(
            {
              audio: storedEntry.audioBlob,
              model: state.settings.asrModel,
              style: preset,
              context,
              appContext: storedEntry.appTag,
              cleanup: state.cleanupConfig,
              dictionary: state.dictionary,
              language: storedEntry.language || 'en',
              filename: 'retranscribe.webm',
            },
            {
              baseUrl: state.settings.serverUrl,
              apiKey: state.settings.apiKey,
              mockMode: false,
            }
          );

          updated = {
            ...storedEntry,
            text: result.formatted_text,
            rawText: result.raw_text,
            numWords: result.num_words,
            durationMs: result.duration_ms || storedEntry.durationMs,
            styleUsed: result.style_applied ?? preset,
            contextUsed: result.category ?? context,
            fillerRemovedCount: result.fillerRemovedCount,
            correctionsAppliedCount: result.correctionsAppliedCount,
          };

          set({ overlayState: 'idle' });
          broadcastOverlay();
          get().pushToast('Re-transcribed with current Style & Dictionary', 'success');
        } else {
          const reprocessed = applyLocalCleanupPipeline(storedEntry.rawText || storedEntry.text, {
            style: preset,
            context,
            cleanup: state.cleanupConfig,
            dictionary: state.dictionary,
          });
          const diff = countStrippedFillersAndCorrections(
            storedEntry.rawText || storedEntry.text,
            reprocessed.text
          );
          updated = {
            ...storedEntry,
            text: reprocessed.text,
            numWords: countWords(reprocessed.text),
            styleUsed: preset,
            contextUsed: context,
            fillerRemovedCount: Math.max(diff.fillersRemoved, reprocessed.fillerRemovedCount),
            correctionsAppliedCount: Math.max(
              diff.correctionsFixed,
              reprocessed.correctionsAppliedCount
            ),
          };
          get().pushToast(
            storedEntry.audioBlob
              ? 'Re-processed locally (Offline demo mode)'
              : 'Re-processed with updated Style & Dictionary',
            'success'
          );
        }

        await saveHistoryEntry(updated);
        set((s) => ({
          history: s.history.map((h) => (h.id === id ? updated : h)),
          retranscribingId: null,
        }));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Re-transcription failed';
        set({ overlayState: 'error', overlayError: message, retranscribingId: null });
        broadcastOverlay();
        get().pushToast(message, 'error');
        errorResetTimer = setTimeout(() => {
          if (get().overlayState === 'error') {
            set({ overlayState: 'idle', overlayError: null });
            broadcastOverlay();
          }
        }, 5000);
      }
    },

    clearHistory: async () => {
      await clearAllHistory();
      set({ history: [] });
      get().pushToast('History cleared');
    },

    startDictation: async (overrideMode) => {
      const state = get();
      if (state.overlayState === 'listening' || state.overlayState === 'transcribing') return;

      if (doneResetTimer) clearTimeout(doneResetTimer);
      if (errorResetTimer) clearTimeout(errorResetTimer);
      if (activeWsSession) {
        activeWsSession.abort();
        activeWsSession = null;
      }

      const startNonce = ++activeStartNonce;
      pendingStopDuringStart = false;

      const effectiveMode = overrideMode ?? state.settings.dictationMode;
      if (overrideMode && overrideMode !== state.settings.dictationMode) {
        get().updateSettings({ dictationMode: overrideMode });
      }

      // Immediately enter listening state synchronously so rapid Hands-free toggle or PTT release never races
      set({
        overlayState: 'listening',
        activeStage: 'record',
        activeRecordingMode: effectiveMode,
        recordingElapsedMs: 0,
        overlayError: null,
        audioLevels: Array(10).fill(0.22),
      });
      broadcastOverlay();

      const detectedApp = await platform.detectActiveApp();
      if (startNonce !== activeStartNonce || get().overlayState !== 'listening') {
        return;
      }

      activeDetectedApp = detectedApp;
      const freshState = get();
      const preset = resolveStylePresetForCategory(
        detectedApp.category,
        freshState.stylesByContext
      );

      if (!freshState.settings.mockMode) {
        try {
          const wsSession = new StreamingDictationSession({
            baseUrl: freshState.settings.serverUrl,
            model: freshState.settings.asrModel,
            appContext: detectedApp.appName,
            appCategory: detectedApp.category,
            preset,
            styleMap: freshState.stylesByContext,
            cleanup: freshState.cleanupConfig,
            dictionary: freshState.dictionary,
            apiKey: freshState.settings.apiKey,
          });
          wsSession.connect();
          activeWsSession = wsSession;
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Invalid server URL for WebSocket.';
          set({
            overlayState: 'error',
            activeRecordingMode: null,
            overlayError: message,
          });
          broadcastOverlay();
          get().pushToast(message, 'error');
          return;
        }
      }

      const silenceTimeoutMs =
        effectiveMode === 'hands_free' && freshState.settings.silenceTimeoutSec > 0
          ? freshState.settings.silenceTimeoutSec * 1000
          : undefined;

      try {
        await audioController.start({
          deviceId: freshState.settings.micDeviceId,
          silenceTimeoutMs,
          maxDurationMs: MAX_MONOLOGUE_DURATION_MS,
          allowSimulatedFallback: freshState.settings.mockMode,
          callbacks: {
            onLevels: (bars) => {
              set({ audioLevels: bars });
              broadcastOverlay();
            },
            onElapsedMs: (elapsedMs) => {
              set({ recordingElapsedMs: elapsedMs });
              broadcastOverlay();
            },
            onPcmPacket: (packet) => {
              activeWsSession?.sendPcmPacket(packet);
            },
            onSilenceTimeout: () => {
              if (get().overlayState === 'listening') {
                void get().stopDictation();
              }
            },
            onMaxDurationTimeout: () => {
              if (get().overlayState === 'listening') {
                get().pushToast('5-minute monologue limit reached — finalizing dictation');
                void get().stopDictation();
              }
            },
          },
        });

        // Handle cancel/stop requested while getUserMedia prompt was pending
        if (startNonce !== activeStartNonce || get().overlayState !== 'listening') {
          audioController.cancel();
          if (activeWsSession) {
            activeWsSession.abort();
            activeWsSession = null;
          }
          return;
        }
        if (pendingStopDuringStart) {
          pendingStopDuringStart = false;
          void get().stopDictation();
        }
      } catch (err) {
        if (activeWsSession) {
          activeWsSession.abort();
          activeWsSession = null;
        }
        const message = err instanceof Error ? err.message : 'Microphone unavailable';
        set({
          overlayState: 'error',
          activeRecordingMode: null,
          overlayError: message,
        });
        broadcastOverlay();
        get().pushToast(message, 'error');
        errorResetTimer = setTimeout(() => {
          if (get().overlayState === 'error') {
            set({ overlayState: 'idle', overlayError: null });
            broadcastOverlay();
          }
        }, 5500);
      }
    },

    stopDictation: async () => {
      const state = get();
      if (state.overlayState !== 'listening') return;

      // Invalidate any pending async mic setup if stop is pressed while initializing
      if (!activeWsSession && !state.settings.mockMode) {
        pendingStopDuringStart = true;
      }

      set({
        overlayState: 'transcribing',
        activeStage: 'polish',
        activeRecordingMode: null,
      });
      broadcastOverlay();

      const wsSession = activeWsSession;
      activeWsSession = null;
      const detectedApp = activeDetectedApp;
      const preset = resolveStylePresetForCategory(detectedApp.category, state.stylesByContext);

      try {
        const recording = await audioController.stop();
        const fresh = get();

        let result;
        if (fresh.settings.mockMode) {
          result = await runMockTranscription(fresh.dictionary, {
            language: 'en',
            style: preset,
            context: detectedApp.category,
            cleanup: fresh.cleanupConfig,
            appContext: detectedApp.appName,
          });
        } else if (wsSession) {
          try {
            result = await wsSession.finish(recording.durationMs);
          } catch (wsErr) {
            if (recording.blob.size > 64) {
              result = await batchTranscribeAudio(
                {
                  audio: recording.blob,
                  model: fresh.settings.asrModel,
                  style: preset,
                  context: detectedApp.category,
                  appContext: detectedApp.appName,
                  cleanup: fresh.cleanupConfig,
                  dictionary: fresh.dictionary,
                  language: 'en',
                  filename: 'dictation.webm',
                },
                {
                  baseUrl: fresh.settings.serverUrl,
                  apiKey: fresh.settings.apiKey,
                  mockMode: false,
                }
              );
            } else {
              throw wsErr;
            }
          }
        } else {
          result = await batchTranscribeAudio(
            {
              audio: recording.blob,
              model: fresh.settings.asrModel,
              style: preset,
              context: detectedApp.category,
              appContext: detectedApp.appName,
              cleanup: fresh.cleanupConfig,
              dictionary: fresh.dictionary,
              language: 'en',
              filename: 'dictation.webm',
            },
            {
              baseUrl: fresh.settings.serverUrl,
              apiKey: fresh.settings.apiKey,
              mockMode: false,
            }
          );
        }

        if (!result.formatted_text) {
          set({ overlayState: 'idle', overlayError: null });
          broadcastOverlay();
          get().pushToast('No speech detected in recording');
          return;
        }

        const resolvedStyle = result.style_applied ?? preset;
        const resolvedCategory = result.category ?? detectedApp.category;
        const resolvedAppName = result.app_context || detectedApp.appName;

        const entry: HistoryEntry = {
          id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          text: result.formatted_text,
          rawText: result.raw_text,
          audioBlob: recording.simulated ? null : recording.blob,
          numWords: result.num_words,
          durationMs: recording.simulated
            ? result.duration_ms
            : result.duration_ms || recording.durationMs,
          timestamp: Date.now(),
          styleUsed: resolvedStyle,
          contextUsed: resolvedCategory,
          appTag: resolvedAppName,
          flagged: false,
          fillerRemovedCount: result.fillerRemovedCount,
          correctionsAppliedCount: result.correctionsAppliedCount,
          language: result.language || 'en',
        };

        await saveHistoryEntry(entry);

        await platform.copyToClipboard(entry.text);
        const inserted = await platform.insertText(entry.text);
        playCompletionChime();

        set((s) => ({
          history: [entry, ...s.history],
          overlayState: 'done',
          activeStage: 'polish',
          overlayError: null,
          lastResult: {
            text: entry.text,
            rawText: entry.rawText,
            appName: entry.appTag,
            styleUsed: resolvedStyle,
            fillerRemovedCount: entry.fillerRemovedCount,
            correctionsAppliedCount: entry.correctionsAppliedCount,
            timestamp: entry.timestamp,
          },
        }));
        broadcastOverlay();

        get().pushToast(
          inserted ? 'Pasted & copied to clipboard' : 'Copied to clipboard',
          'success'
        );

        doneResetTimer = setTimeout(() => {
          if (get().overlayState === 'done') {
            set({ overlayState: 'idle' });
            broadcastOverlay();
          }
        }, 1600);
      } catch (err) {
        wsSession?.abort();
        const message = err instanceof Error ? err.message : 'Transcription failed';
        set({
          overlayState: 'error',
          activeRecordingMode: null,
          overlayError: message,
        });
        broadcastOverlay();
        get().pushToast(message, 'error');
        errorResetTimer = setTimeout(() => {
          if (get().overlayState === 'error') {
            set({ overlayState: 'idle', overlayError: null });
            broadcastOverlay();
          }
        }, 5500);
      }
    },

    cancelDictation: () => {
      activeStartNonce += 1;
      pendingStopDuringStart = false;
      if (activeWsSession) {
        activeWsSession.abort();
        activeWsSession = null;
      }
      audioController.cancel();
      set({
        overlayState: 'idle',
        activeStage: 'record',
        activeRecordingMode: null,
        recordingElapsedMs: 0,
        overlayError: null,
        audioLevels: Array(10).fill(0.18),
      });
      broadcastOverlay();
    },

    clearOverlayError: () => {
      set({ overlayState: 'idle', overlayError: null });
      broadcastOverlay();
    },

    setTestInputText: (testInputText) => set({ testInputText }),

    appendTestInputText: (value) =>
      set((s) => {
        const trimmed = s.testInputText.trimEnd();
        const next = trimmed ? `${trimmed}\n${value}` : value;
        return { testInputText: next };
      }),

    pushToast: (message, tone = 'default') => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
      set((s) => ({ toasts: [...s.toasts.slice(-2), { id, message, tone }] }));
      setTimeout(() => {
        get().dismissToast(id);
      }, 3200);
    },

    dismissToast: (id) =>
      set((s) => ({
        toasts: s.toasts.filter((t) => t.id !== id),
      })),
  };
});
