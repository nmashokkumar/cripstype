import type { DictationMode, HotkeyBinding } from '../types';
import { classifyAppContext, type DetectedAppContext } from '../utils/appClassifier';

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
 * - Electron (.exe / .deb / .dmg) via `window.flowNative` or `window.electronAPI`
 * - Tauri / Capacitor Android (.apk) via `window.flowNative`
 */
export interface PlatformBridge {
  readonly isNativeHost: boolean;
  detectActiveApp(): Promise<DetectedAppContext>;
  insertText(text: string): Promise<boolean>;
  copyToClipboard(text: string): Promise<boolean>;
  registerTestInputSink(sink: ((text: string) => void) | null): void;
  setOverlayInteractive(interactive: boolean): void;
  syncNativeHotkeys(bindings: { pushToTalk: HotkeyBinding; handsFree: HotkeyBinding }): void;
  subscribeNativeCommands(handlers: NativeCommandHandlers): () => void;
}

class CrossPlatformBridge implements PlatformBridge {
  private testInputSink: ((text: string) => void) | null = null;

  get isNativeHost(): boolean {
    if (typeof window === 'undefined') return false;
    return Boolean(window.flowNative || window.electronAPI);
  }

  registerTestInputSink(sink: ((text: string) => void) | null): void {
    this.testInputSink = sink;
  }

  /**
   * Automatically identifies the currently focused OS application via the native wrapper
   * (Electron / Tauri / Android Accessibility bridge), falling back cleanly on web.
   */
  async detectActiveApp(): Promise<DetectedAppContext> {
    if (typeof window !== 'undefined') {
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

      // Web fallback: infer context from document title if recognizable, else "Browser"
      const title = document.title?.trim() ?? '';
      if (title && !/^flow\b/i.test(title)) {
        const classified = classifyAppContext('', title);
        if (classified.category !== 'other') {
          return classified;
        }
      }
      return { appName: 'Browser', category: 'other' };
    }

    return { appName: 'Desktop', category: 'other' };
  }

  async insertText(text: string): Promise<boolean> {
    if (!text) return false;

    // 1. Prefer native OS-level text injection when hosted inside a wrapper
    if (typeof window !== 'undefined') {
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

    // 2. Web / in-app test pad sink
    if (this.testInputSink) {
      this.testInputSink(text);
      return true;
    }

    return false;
  }

  async copyToClipboard(text: string): Promise<boolean> {
    if (!text) return false;

    if (typeof window !== 'undefined' && typeof window.flowNative?.copyText === 'function') {
      try {
        const copied = await window.flowNative.copyText(text);
        if (copied) return true;
      } catch {
        // Fall through to Web Clipboard API
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

  syncNativeHotkeys(bindings: { pushToTalk: HotkeyBinding; handsFree: HotkeyBinding }): void {
    if (typeof window === 'undefined') return;
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

  subscribeNativeCommands(handlers: NativeCommandHandlers): () => void {
    if (typeof window === 'undefined') return () => {};
    const bridge = window.flowNative ?? window.electronAPI;
    if (!bridge) return () => {};

    const cleanups: Array<() => void> = [];
    const register = (maybeUnsub: (() => void) | void) => {
      if (typeof maybeUnsub === 'function') {
        cleanups.push(maybeUnsub);
      }
    };

    register(bridge.onDictationStart?.((mode) => handlers.onStart(mode)));
    register(bridge.onDictationStop?.(() => handlers.onStop()));
    register(bridge.onDictationToggle?.(() => handlers.onToggle()));
    register(bridge.onOpenSettings?.(() => handlers.onOpenSettings()));

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
