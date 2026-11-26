import type { DictationMode, HotkeyBinding } from '../types';
import { classifyAppContext, type DetectedAppContext } from '../utils/appClassifier';

export interface HotkeyConflict {
  shortcut: string;
  ownerName: string;
  schema: string;
  key: string;
}

export interface HotkeyApplyResult {
  applied: boolean;
  conflict: HotkeyConflict | null;
}

export interface NativeCommandHandlers {
  onStart: (mode?: DictationMode) => void;
  onStop: () => void;
  onToggle: () => void;
  onOpenSettings: () => void;
}

/**
 * OS-agnostic platform bridge.
 * Works seamlessly in:
 * - Standard web browsers (local test pad + clipboard)
 * - Tauri v2 desktop apps (.deb / .AppImage / .exe / .dmg) via `window.__TAURI__` / `__TAURI_INTERNALS__`
 * - Electron (.exe / .deb / .dmg) via `window.flowNative` or `window.electronAPI`
 * - Capacitor Android (.apk) via `window.flowNative`
 */
export interface PlatformBridge {
  readonly isNativeHost: boolean;
  readonly isTauriHost: boolean;
  detectActiveApp(): Promise<DetectedAppContext>;
  insertText(text: string): Promise<boolean>;
  copyToClipboard(text: string): Promise<boolean>;
  registerTestInputSink(sink: ((text: string) => void) | null): void;
  setOverlayInteractive(interactive: boolean): void;
  setOverlayVisible(visible: boolean): void;
  setAutoStart(enabled: boolean): Promise<boolean>;
  getAutoStart(): Promise<boolean | null>;
  setMinimizeToTray(enabled: boolean): Promise<void>;
  syncNativeHotkeys(bindings: { pushToTalk: HotkeyBinding; handsFree: HotkeyBinding }): void;
  applyNativeHotkeysChecked(
    bindings: { pushToTalk: HotkeyBinding; handsFree: HotkeyBinding },
    forceReplace?: boolean
  ): Promise<HotkeyApplyResult>;
  subscribeNativeCommands(handlers: NativeCommandHandlers): () => void;
}

function getTauriInvoke():
  | (<T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>)
  | null {
  if (typeof window === 'undefined') return null;
  const invoke = window.__TAURI__?.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke;
  return typeof invoke === 'function' ? invoke : null;
}

class CrossPlatformBridge implements PlatformBridge {
  private testInputSink: ((text: string) => void) | null = null;
  private lastOverlayVisible: boolean | null = null;

  get isTauriHost(): boolean {
    return getTauriInvoke() !== null;
  }

  get isNativeHost(): boolean {
    if (typeof window === 'undefined') return false;
    return Boolean(window.flowNative || window.electronAPI || this.isTauriHost);
  }

  registerTestInputSink(sink: ((text: string) => void) | null): void {
    this.testInputSink = sink;
  }

  /**
   * Automatically identifies the currently focused OS application via the native wrapper
   * (Tauri / Electron / Android Accessibility bridge), falling back cleanly on web.
   */
  async detectActiveApp(): Promise<DetectedAppContext> {
    if (typeof window !== 'undefined') {
      const tauriInvoke = getTauriInvoke();
      if (tauriInvoke) {
        try {
          const info = await tauriInvoke<{ appName?: string; windowTitle?: string } | string | null>(
            'get_active_app'
          );
          if (typeof info === 'string' && info.trim()) {
            return classifyAppContext(info);
          }
          if (info && typeof info === 'object' && (info.appName || info.windowTitle)) {
            return classifyAppContext(info.appName, info.windowTitle);
          }
        } catch {
          // Fall through cleanly if desktop window info is unavailable
        }
      }

      const getter = window.flowNative?.getActiveApp ?? window.electronAPI?.getActiveApp;
      if (typeof getter === 'function') {
        try {
          const info = await getter();
          if (typeof info === 'string' && info.trim()) {
            return classifyAppContext(info);
          }
          if (info && typeof info === 'object') {
            return classifyAppContext(info.appName, info.windowTitle);
          }
        } catch {
          // Fall through cleanly if OS accessibility permission is unavailable
        }
      }

      // Web fallback: infer context from document title if recognizable, else "General"
      const title = document.title?.trim() ?? '';
      if (title && !/^(flow|crisptype)\b/i.test(title)) {
        const classified = classifyAppContext('', title);
        if (classified.category !== 'other') {
          return classified;
        }
      }
      return { appName: this.isNativeHost ? 'General' : 'Browser', category: 'other' };
    }

    return { appName: 'General', category: 'other' };
  }

  async insertText(text: string): Promise<boolean> {
    if (!text) return false;

    if (typeof window !== 'undefined') {
      // 1. Prefer Tauri native paste when hosted inside CrispType desktop app
      const tauriInvoke = getTauriInvoke();
      if (tauriInvoke) {
        try {
          const pasted = await tauriInvoke<boolean>('paste_text', { text });
          if (pasted) return true;
        } catch {
          // Fall through cleanly to clipboard / test sink
        }
      }

      // 2. Native mobile / custom bridge
      const nativePaste = window.flowNative?.pasteText ?? window.electronAPI?.pasteText;
      if (typeof nativePaste === 'function') {
        try {
          const pasted = await nativePaste(text);
          if (pasted) return true;
        } catch {
          // Fall through to local test sink
        }
      }
    }

    // 3. Web / in-app test pad sink
    if (this.testInputSink) {
      this.testInputSink(text);
      return true;
    }

    return false;
  }

  async copyToClipboard(text: string): Promise<boolean> {
    if (!text) return false;

    if (typeof window !== 'undefined') {
      const tauriInvoke = getTauriInvoke();
      if (tauriInvoke) {
        try {
          const copied = await tauriInvoke<boolean>('copy_text', { text });
          if (copied) return true;
        } catch {
          // Fall through to Web Clipboard API
        }
      }

      if (typeof window.flowNative?.copyText === 'function') {
        try {
          const copied = await window.flowNative.copyText(text);
          if (copied) return true;
        } catch {
          // Fall through to Web Clipboard API
        }
      }
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fallback for insecure contexts / iframe clipboard restrictions
    }

    try {
      const el = document.createElement('textarea');
      el.value = text;
      el.setAttribute('readonly', '');
      el.style.position = 'fixed';
      el.style.left = '-9999px';
      document.body.appendChild(el);
      el.select();
      const copied = document.execCommand('copy');
      document.body.removeChild(el);
      return copied;
    } catch {
      return false;
    }
  }

  /**
   * Controls click-through on frameless desktop overlay windows.
   * Ensures Hands-free finish button (`✓`) and error dismiss remain clickable.
   */
  setOverlayInteractive(interactive: boolean): void {
    if (typeof window === 'undefined') return;

    const tauriInvoke = getTauriInvoke();
    if (tauriInvoke) {
      void tauriInvoke('set_overlay_interactive', { interactive }).catch(() => undefined);
    }

    const setter =
      window.flowNative?.setOverlayIgnoreMouseEvents ?? window.electronAPI?.setIgnoreMouseEvents;
    if (typeof setter !== 'function') return;
    try {
      if (interactive) {
        setter(false);
      } else {
        setter(true, { forward: true });
      }
    } catch {
      // Ignore bridge errors in non-overlay windows
    }
  }

  /**
   * Shows or hides the always-on-top floating overlay window so it pops over
   * any app even when the main CrispType window is closed to the system tray.
   */
  setOverlayVisible(visible: boolean): void {
    if (typeof window === 'undefined') return;
    if (this.lastOverlayVisible === visible) return;
    this.lastOverlayVisible = visible;

    const tauriInvoke = getTauriInvoke();
    if (tauriInvoke) {
      void tauriInvoke('set_overlay_visible', { visible }).catch(() => undefined);
    }

    const setter = window.flowNative?.setOverlayVisible ?? window.electronAPI?.setOverlayVisible;
    if (typeof setter === 'function') {
      try {
        void setter(visible);
      } catch {
        // Ignore bridge errors
      }
    }
  }

  async setAutoStart(enabled: boolean): Promise<boolean> {
    if (typeof window === 'undefined') return false;

    const tauriInvoke = getTauriInvoke();
    if (tauriInvoke) {
      try {
        await tauriInvoke('set_autostart', { enabled });
        return true;
      } catch {
        return false;
      }
    }

    const setter = window.flowNative?.setAutoStart ?? window.electronAPI?.setAutoStart;
    if (typeof setter === 'function') {
      try {
        const res = await setter(enabled);
        return res !== false;
      } catch {
        return false;
      }
    }
    return false;
  }

  async getAutoStart(): Promise<boolean | null> {
    if (typeof window === 'undefined') return null;

    const tauriInvoke = getTauriInvoke();
    if (tauriInvoke) {
      try {
        const enabled = await tauriInvoke<boolean>('get_autostart');
        return typeof enabled === 'boolean' ? enabled : null;
      } catch {
        return null;
      }
    }

    const getter = window.flowNative?.getAutoStart ?? window.electronAPI?.getAutoStart;
    if (typeof getter === 'function') {
      try {
        return Boolean(await getter());
      } catch {
        return null;
      }
    }
    return null;
  }

  async setMinimizeToTray(enabled: boolean): Promise<void> {
    if (typeof window === 'undefined') return;

    const tauriInvoke = getTauriInvoke();
    if (tauriInvoke) {
      try {
        await tauriInvoke('set_minimize_to_tray', { enabled });
      } catch {
        // Ignore if command unavailable
      }
      return;
    }

    const setter = window.flowNative?.setMinimizeToTray ?? window.electronAPI?.setMinimizeToTray;
    if (typeof setter === 'function') {
      try {
        await setter(enabled);
      } catch {
        // Ignore
      }
    }
  }

  syncNativeHotkeys(bindings: { pushToTalk: HotkeyBinding; handsFree: HotkeyBinding }): void {
    if (typeof window === 'undefined') return;

    const tauriInvoke = getTauriInvoke();
    if (tauriInvoke) {
      void tauriInvoke('update_hotkeys', {
        pushToTalk: bindings.pushToTalk,
        handsFree: bindings.handsFree,
      }).catch(() => undefined);
    }

    try {
      if (typeof window.flowNative?.updateHotkeys === 'function') {
        window.flowNative.updateHotkeys(bindings);
      } else if (typeof window.electronAPI?.updateHotkeys === 'function') {
        window.electronAPI.updateHotkeys({
          pushToTalk: bindings.pushToTalk.label,
          handsFree: bindings.handsFree.label,
        });
      }
    } catch {
      // Ignore if host wrapper does not support dynamic hotkey updates
    }
  }

  async applyNativeHotkeysChecked(
    bindings: { pushToTalk: HotkeyBinding; handsFree: HotkeyBinding },
    forceReplace = false
  ): Promise<HotkeyApplyResult> {
    if (typeof window === 'undefined') return { applied: true, conflict: null };
    const tauriInvoke = getTauriInvoke();
    if (tauriInvoke) {
      try {
        return await tauriInvoke<HotkeyApplyResult>('apply_hotkeys', {
          pushToTalk: bindings.pushToTalk,
          handsFree: bindings.handsFree,
          forceReplace,
        });
      } catch {
        return { applied: true, conflict: null };
      }
    }
    this.syncNativeHotkeys(bindings);
    return { applied: true, conflict: null };
  }

  subscribeNativeCommands(handlers: NativeCommandHandlers): () => void {
    if (typeof window === 'undefined') return () => {};

    const cleanups: Array<() => void> = [];
    const register = (maybeUnsub: (() => void) | void) => {
      if (typeof maybeUnsub === 'function') {
        cleanups.push(maybeUnsub);
      }
    };

    // 1. Electron / Capacitor bridge callbacks
    const bridge = window.flowNative ?? window.electronAPI;
    if (bridge) {
      register(bridge.onDictationStart?.((mode) => handlers.onStart(mode)));
      register(bridge.onDictationStop?.(() => handlers.onStop()));
      register(bridge.onDictationToggle?.(() => handlers.onToggle()));
      register(bridge.onOpenSettings?.(() => handlers.onOpenSettings()));
    }

    // 2. Tauri v2 event bridge (`withGlobalTauri: true`)
    const tauriListen = window.__TAURI__?.event?.listen;
    if (typeof tauriListen === 'function') {
      let disposed = false;
      const tauriUnsubs: Array<() => void> = [];
      const attach = <T,>(eventName: string, fn: (payload: T) => void) => {
        void tauriListen<T>(eventName, (ev) => fn(ev.payload))
          .then((unlisten) => {
            if (disposed) {
              unlisten();
            } else {
              tauriUnsubs.push(unlisten);
            }
          })
          .catch(() => undefined);
      };

      attach<DictationMode | undefined>('crisptype:dictation-start', (mode) => handlers.onStart(mode));
      attach<void>('crisptype:dictation-stop', () => handlers.onStop());
      attach<void>('crisptype:dictation-toggle', () => handlers.onToggle());
      attach<void>('crisptype:open-settings', () => handlers.onOpenSettings());

      cleanups.push(() => {
        disposed = true;
        for (const unlisten of tauriUnsubs) {
          try {
            unlisten();
          } catch {
            // Ignore
          }
        }
      });
    }

    // 3. Fallback DOM CustomEvent listeners (dispatched by native wrappers when needed)
    const onDomStart = (ev: Event) => {
      const detail = (ev as CustomEvent<{ mode?: DictationMode }>).detail;
      handlers.onStart(detail?.mode);
    };
    const onDomStop = () => handlers.onStop();
    const onDomToggle = () => handlers.onToggle();
    const onDomSettings = () => handlers.onOpenSettings();

    window.addEventListener('crisptype:dictation-start', onDomStart);
    window.addEventListener('crisptype:dictation-stop', onDomStop);
    window.addEventListener('crisptype:dictation-toggle', onDomToggle);
    window.addEventListener('crisptype:open-settings', onDomSettings);

    cleanups.push(() => {
      window.removeEventListener('crisptype:dictation-start', onDomStart);
      window.removeEventListener('crisptype:dictation-stop', onDomStop);
      window.removeEventListener('crisptype:dictation-toggle', onDomToggle);
      window.removeEventListener('crisptype:open-settings', onDomSettings);
    });

    return () => {
      for (const unsub of cleanups) {
        try {
          unsub();
        } catch {
          // Ignore cleanup errors
        }
      }
    };
  }
}

export const platform: PlatformBridge = new CrossPlatformBridge();
