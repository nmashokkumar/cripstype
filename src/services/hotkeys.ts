import type { DictationMode, HotkeyBinding } from '../types';

export const DEFAULT_PTT_HOTKEY: HotkeyBinding = {
  code: 'Fn',
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
  label: 'fn',
};

export const DEFAULT_HANDS_FREE_HOTKEY: HotkeyBinding = {
  code: 'Space',
  ctrl: true,
  alt: true,
  shift: false,
  meta: false,
  label: 'Ctrl + Alt + Space',
};

export const QUICK_HOTKEY_PRESETS: Array<{ label: string; binding: HotkeyBinding }> = [
  { label: 'fn', binding: DEFAULT_PTT_HOTKEY },
  {
    label: 'Right Ctrl',
    binding: { code: 'ControlRight', ctrl: false, alt: false, shift: false, meta: false, label: 'Right Ctrl' },
  },
  {
    label: 'Right Alt',
    binding: { code: 'AltRight', ctrl: false, alt: false, shift: false, meta: false, label: 'Right Alt' },
  },
  {
    label: 'Ctrl + Space',
    binding: { code: 'Space', ctrl: true, alt: false, shift: false, meta: false, label: 'Ctrl + Space' },
  },
  {
    label: 'Alt + Space',
    binding: { code: 'Space', ctrl: false, alt: true, shift: false, meta: false, label: 'Alt + Space' },
  },
  { label: 'Ctrl + Alt + Space', binding: DEFAULT_HANDS_FREE_HOTKEY },
  {
    label: 'Ctrl + Shift + Space',
    binding: { code: 'Space', ctrl: true, alt: false, shift: true, meta: false, label: 'Ctrl + Shift + Space' },
  },
];

export interface HotkeySubscriptionConfig {
  pushToTalkHotkey: HotkeyBinding;
  handsFreeHotkey: HotkeyBinding;
  onStart: (triggeredMode: DictationMode) => void;
  onStop: () => void;
  onCancel: () => void;
  isListening: () => boolean;
  getActiveMode: () => DictationMode;
  isSuspended?: () => boolean;
}

/**
 * Abstraction for hotkey listeners.
 * Swap BrowserHotkeyProvider for an Electron / Tauri / Android native shortcut hook
 * when wrapping this app for desktop or mobile builds.
 */
export interface HotkeyProvider {
  subscribe(config: HotkeySubscriptionConfig): () => void;
}

const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
  'MetaLeft',
  'MetaRight',
]);

export function isModifierCode(code: string): boolean {
  return MODIFIER_CODES.has(code);
}

export function normalizeEventCode(e: { code: string; key?: string; location?: number }): string {
  if (e.key === 'Fn' || e.code === 'WakeUp') return 'Fn';
  // Disambiguate Control / Alt / Shift / Meta using DOM location when code is generic
  if (e.code === 'Control' || (e.key === 'Control' && !e.code)) {
    return e.location === 2 ? 'ControlRight' : 'ControlLeft';
  }
  if (e.code === 'Alt' || (e.key === 'Alt' && !e.code)) {
    return e.location === 2 ? 'AltRight' : 'AltLeft';
  }
  if (e.code === 'Shift' || (e.key === 'Shift' && !e.code)) {
    return e.location === 2 ? 'ShiftRight' : 'ShiftLeft';
  }
  if (e.code === 'Meta' || (e.key === 'Meta' && !e.code)) {
    return e.location === 2 ? 'MetaRight' : 'MetaLeft';
  }
  return e.code;
}

export function formatKeyCodeLabel(code: string): string {
  const map: Record<string, string> = {
    Fn: 'fn',
    WakeUp: 'fn',
    ControlRight: 'Right Ctrl',
    ControlLeft: 'Left Ctrl',
    AltRight: 'Right Alt',
    AltLeft: 'Left Alt',
    MetaRight: 'Right Super',
    MetaLeft: 'Left Super',
    ShiftRight: 'Right Shift',
    ShiftLeft: 'Left Shift',
    Space: 'Space',
    Backquote: '`',
    CapsLock: 'Caps Lock',
    Tab: 'Tab',
    Enter: 'Enter',
    Backspace: 'Backspace',
    ContextMenu: 'Menu',
  };
  if (map[code]) return map[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code;
}

export function formatHotkeyBinding(binding: Omit<HotkeyBinding, 'label'>): string {
  const parts: string[] = [];
  const codeIsCtrl = binding.code === 'ControlLeft' || binding.code === 'ControlRight';
  const codeIsAlt = binding.code === 'AltLeft' || binding.code === 'AltRight';
  const codeIsShift = binding.code === 'ShiftLeft' || binding.code === 'ShiftRight';
  const codeIsMeta = binding.code === 'MetaLeft' || binding.code === 'MetaRight';

  if (binding.ctrl && !codeIsCtrl) parts.push('Ctrl');
  if (binding.alt && !codeIsAlt) parts.push('Alt');
  if (binding.shift && !codeIsShift) parts.push('Shift');
  if (binding.meta && !codeIsMeta) parts.push('Super');

  parts.push(formatKeyCodeLabel(binding.code));
  return parts.join(' + ');
}

export interface KeyEventLike {
  code: string;
  key?: string;
  location?: number;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/**
 * Builds a single-key, two-key, or three-key HotkeyBinding from a KeyboardEvent.
 * Supports:
 * - 1-key: Right Ctrl, Left Ctrl, Right Alt, fn, Caps Lock, F8, etc.
 * - 2-key: Ctrl + Space, Alt + Space, Ctrl + Right Alt, Right Ctrl + Shift, etc.
 * - 3-key: Ctrl + Alt + Space, Ctrl + Shift + D, etc.
 */
export function bindingFromKeyEvent(e: KeyEventLike): HotkeyBinding {
  const code = normalizeEventCode(e);
  const codeIsCtrl = code === 'ControlLeft' || code === 'ControlRight';
  const codeIsAlt = code === 'AltLeft' || code === 'AltRight';
  const codeIsShift = code === 'ShiftLeft' || code === 'ShiftRight';
  const codeIsMeta = code === 'MetaLeft' || code === 'MetaRight';

  const raw: Omit<HotkeyBinding, 'label'> = {
    code,
    ctrl: codeIsCtrl ? false : Boolean(e.ctrlKey),
    alt: codeIsAlt ? false : Boolean(e.altKey),
    shift: codeIsShift ? false : Boolean(e.shiftKey),
    meta: codeIsMeta ? false : Boolean(e.metaKey),
  };

  return {
    ...raw,
    label: formatHotkeyBinding(raw),
  };
}

export function matchesHotkeyDown(e: KeyEventLike, binding: HotkeyBinding): boolean {
  const eventCode = normalizeEventCode(e);
  if (eventCode !== binding.code) return false;

  const expectCtrl =
    Boolean(binding.ctrl) || binding.code === 'ControlLeft' || binding.code === 'ControlRight';
  const expectAlt =
    Boolean(binding.alt) || binding.code === 'AltLeft' || binding.code === 'AltRight';
  const expectShift =
    Boolean(binding.shift) || binding.code === 'ShiftLeft' || binding.code === 'ShiftRight';
  const expectMeta =
    Boolean(binding.meta) || binding.code === 'MetaLeft' || binding.code === 'MetaRight';

  return (
    Boolean(e.ctrlKey) === expectCtrl &&
    Boolean(e.altKey) === expectAlt &&
    Boolean(e.shiftKey) === expectShift &&
    Boolean(e.metaKey) === expectMeta
  );
}

export function matchesHotkeyRelease(e: KeyEventLike, binding: HotkeyBinding): boolean {
  const eventCode = normalizeEventCode(e);
  if (eventCode === binding.code) return true;
  if (binding.ctrl && (eventCode === 'ControlLeft' || eventCode === 'ControlRight')) return true;
  if (binding.alt && (eventCode === 'AltLeft' || eventCode === 'AltRight')) return true;
  if (binding.shift && (eventCode === 'ShiftLeft' || eventCode === 'ShiftRight')) return true;
  if (binding.meta && (eventCode === 'MetaLeft' || eventCode === 'MetaRight')) return true;
  return false;
}

export function isSameHotkeyBinding(a: HotkeyBinding, b: HotkeyBinding): boolean {
  return (
    a.code === b.code &&
    Boolean(a.ctrl) === Boolean(b.ctrl) &&
    Boolean(a.alt) === Boolean(b.alt) &&
    Boolean(a.shift) === Boolean(b.shift) &&
    Boolean(a.meta) === Boolean(b.meta)
  );
}

export class BrowserHotkeyProvider implements HotkeyProvider {
  subscribe(config: HotkeySubscriptionConfig): () => void {
    let pttHeld = false;
    let lastHandsFreeTapAt = 0;
    let suppressNextSpaceKeyUp = false;

    const shouldIgnoreForTyping = (target: EventTarget | null, binding: HotkeyBinding): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      const isEditable = tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
      if (!isEditable) return false;
      const hasAccelerator = Boolean(binding.ctrl || binding.alt || binding.meta);
      const isSpecialKey =
        isModifierCode(binding.code) || binding.code === 'Fn' || /^F\d+$/.test(binding.code);
      return !(hasAccelerator || isSpecialKey);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (config.isSuspended?.()) return;

      const eventCode = normalizeEventCode(e);

      // Escape stops hands-free or cancels push-to-talk
      if (eventCode === 'Escape' && config.isListening()) {
        e.preventDefault();
        e.stopPropagation();
        if (config.getActiveMode() === 'hands_free') {
          config.onStop();
        } else {
          pttHeld = false;
          config.onCancel();
        }
        return;
      }

      if (e.repeat) return;

      // 1. Check Hands-free hotkey first
      if (matchesHotkeyDown(e, config.handsFreeHotkey)) {
        if (shouldIgnoreForTyping(e.target, config.handsFreeHotkey)) return;
        e.preventDefault();
        e.stopPropagation();
        if (eventCode === 'Space') suppressNextSpaceKeyUp = true;

        const now = performance.now();
        if (config.isListening()) {
          if (now - lastHandsFreeTapAt < 180) return;
          lastHandsFreeTapAt = now;
          pttHeld = false;
          config.onStop();
        } else {
          lastHandsFreeTapAt = now;
          pttHeld = false;
          config.onStart('hands_free');
        }
        return;
      }

      // 2. Check Push-to-talk hotkey (hold to record, release to stop)
      if (matchesHotkeyDown(e, config.pushToTalkHotkey)) {
        if (shouldIgnoreForTyping(e.target, config.pushToTalkHotkey)) return;
        e.preventDefault();
        e.stopPropagation();
        if (eventCode === 'Space') suppressNextSpaceKeyUp = true;

        if (!pttHeld && !config.isListening()) {
          pttHeld = true;
          config.onStart('push_to_talk');
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (config.isSuspended?.()) return;

      const eventCode = normalizeEventCode(e);
      if (suppressNextSpaceKeyUp && eventCode === 'Space') {
        suppressNextSpaceKeyUp = false;
        e.preventDefault();
        e.stopPropagation();
      }

      if (pttHeld && matchesHotkeyRelease(e, config.pushToTalkHotkey)) {
        pttHeld = false;
        if (config.isListening()) {
          config.onStop();
        }
      }
    };

    const handleWindowBlur = () => {
      suppressNextSpaceKeyUp = false;
      if (pttHeld) {
        pttHeld = false;
        if (config.isListening()) {
          config.onStop();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    window.addEventListener('keyup', handleKeyUp, { capture: true });
    window.addEventListener('blur', handleWindowBlur);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      window.removeEventListener('keyup', handleKeyUp, { capture: true });
      window.removeEventListener('blur', handleWindowBlur);
    };
  }
}

export const hotkeyProvider: HotkeyProvider = new BrowserHotkeyProvider();
