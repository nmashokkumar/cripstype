import { useEffect } from 'react';
import { OverlayPill } from '../components/OverlayPill';
import { useFlowStore } from '../store/useFlowStore';
import { platform } from '../services/platform';

/**
 * Standalone transparent /overlay route for always-on-top frameless native windows
 * (Tauri .deb/.AppImage/.exe/.dmg, Electron, or mobile overlay containers).
 *
 * State streams in real time from the main window (which stays alive in the system tray
 * even when closed), and interactive clicks (e.g. Hands-free finish `✓`) relay back to
 * the main window via BroadcastChannel + Tauri events.
 */
export function OverlayRoute() {
  const settings = useFlowStore((s) => s.settings);
  const overlayState = useFlowStore((s) => s.overlayState);
  const activeRecordingMode = useFlowStore((s) => s.activeRecordingMode);

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

  return (
    <main className="min-h-screen w-full bg-transparent">
      <OverlayPill standalone />
    </main>
  );
}
