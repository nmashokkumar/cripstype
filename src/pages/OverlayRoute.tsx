import { useEffect } from 'react';
import { OverlayPill } from '../components/OverlayPill';
import { useFlowStore } from '../store/useFlowStore';
import { hotkeyProvider } from '../services/hotkeys';
import { platform } from '../services/platform';

/**
 * Standalone transparent /overlay route for always-on-top frameless native windows
 * (Electron .exe/.deb/.dmg, Tauri, or mobile overlay containers).
 *
 * Automatically toggles window click-through so the pill never steals focus while idle
 * or holding push-to-talk, yet keeps the Hands-free finish (`✓`) button clickable.
 */
export function OverlayRoute() {
  const settings = useFlowStore((s) => s.settings);
  const overlayState = useFlowStore((s) => s.overlayState);
  const activeRecordingMode = useFlowStore((s) => s.activeRecordingMode);
  const startDictation = useFlowStore((s) => s.startDictation);
  const stopDictation = useFlowStore((s) => s.stopDictation);
  const cancelDictation = useFlowStore((s) => s.cancelDictation);

  useEffect(() => {
    document.documentElement.classList.add('overlay-transparent');
    document.body.classList.add('overlay-transparent');
    return () => {
      document.documentElement.classList.remove('overlay-transparent');
      document.body.classList.remove('overlay-transparent');
    };
  }, []);

  // Keep the floating overlay clickable during Hands-free recording (for the ✓ button) and errors
  useEffect(() => {
    const isHandsFreeListening =
      overlayState === 'listening' &&
      (activeRecordingMode ?? settings.dictationMode) === 'hands_free';
    const needsPointerEvents = isHandsFreeListening || overlayState === 'error';
    platform.setOverlayInteractive(needsPointerEvents);
  }, [overlayState, activeRecordingMode, settings.dictationMode]);

  useEffect(() => {
    const unsubHotkeys = hotkeyProvider.subscribe({
      pushToTalkHotkey: settings.pushToTalkHotkey,
      handsFreeHotkey: settings.handsFreeHotkey,
      onStart: (mode) => void startDictation(mode),
      onStop: () => void stopDictation(),
      onCancel: () => cancelDictation(),
      isListening: () => useFlowStore.getState().overlayState === 'listening',
      getActiveMode: () =>
        useFlowStore.getState().activeRecordingMode ?? useFlowStore.getState().settings.dictationMode,
    });

    const unsubNative = platform.subscribeNativeCommands({
      onStart: (mode) => void startDictation(mode),
      onStop: () => void stopDictation(),
      onToggle: () => {
        if (useFlowStore.getState().overlayState === 'listening') {
          void stopDictation();
        } else {
          void startDictation('hands_free');
        }
      },
      onOpenSettings: () => {},
    });

    return () => {
      unsubHotkeys();
      unsubNative();
    };
  }, [
    settings.pushToTalkHotkey,
    settings.handsFreeHotkey,
    startDictation,
    stopDictation,
    cancelDictation,
  ]);

  return (
    <main className="min-h-screen w-full bg-transparent">
      <OverlayPill standalone />
    </main>
  );
}
