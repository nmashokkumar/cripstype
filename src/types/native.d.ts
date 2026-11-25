import type { HotkeyBinding } from '../types';

export interface NativeActiveAppInfo {
  /** OS process / executable / Android package name (e.g. "WhatsApp.exe", "com.whatsapp", "Gmail") */
  appName?: string;
  /** Active window title when available on desktop */
  windowTitle?: string;
  /** Optional OS platform identifier */
  platform?: 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'web';
}

/**
 * Unified native bridge interface that any desktop or mobile wrapper
 * (Electron .exe/.deb/.dmg, Tauri, or Capacitor/Android .apk) can expose on `window.flowNative`.
 */
export interface FlowNativeBridge {
  platform?: 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'web';
  /** Detect the currently focused OS application before/during dictation */
  getActiveApp?: () => Promise<NativeActiveAppInfo | string | null>;
  /** Inject polished text directly into the currently focused external window or input */
  pasteText?: (text: string) => Promise<boolean>;
  /** Copy text to the OS clipboard */
  copyText?: (text: string) => Promise<boolean>;
  /** Toggle click-through on a frameless floating overlay window (must remain interactive during hands-free) */
  setOverlayIgnoreMouseEvents?: (ignore: boolean, options?: { forward?: boolean }) => void;
  /** Sync user-configured shortcuts with the native global hotkey daemon */
  updateHotkeys?: (bindings: { pushToTalk: HotkeyBinding; handsFree: HotkeyBinding }) => void;
  /** Subscribe to global native hotkey triggers; returns an unsubscribe callback */
  onDictationStart?: (cb: (mode?: 'push_to_talk' | 'hands_free') => void) => (() => void) | void;
  onDictationStop?: (cb: () => void) => (() => void) | void;
  onDictationToggle?: (cb: () => void) => (() => void) | void;
  onOpenSettings?: (cb: () => void) => (() => void) | void;
}

/**
 * Backwards-compatible Electron preload API shape (matches electron/preload.cjs wrappers).
 */
export interface ElectronLegacyAPI {
  getActiveApp?: () => Promise<NativeActiveAppInfo | string | null>;
  pasteText?: (text: string) => Promise<boolean>;
  setIgnoreMouseEvents?: (ignore: boolean, options?: { forward?: boolean }) => void;
  updateHotkeys?: (bindings: { pushToTalk?: string; handsFree?: string }) => void;
  onDictationStart?: (cb: (mode?: 'push_to_talk' | 'hands_free') => void) => (() => void) | void;
  onDictationStop?: (cb: () => void) => (() => void) | void;
  onDictationToggle?: (cb: () => void) => (() => void) | void;
  onOpenSettings?: (cb: () => void) => (() => void) | void;
}

declare global {
  interface Window {
    flowNative?: FlowNativeBridge;
    electronAPI?: ElectronLegacyAPI;
  }
}

export {};
