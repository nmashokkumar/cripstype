import { useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  Keyboard,
  Loader2,
  Mic,
  Moon,
  RotateCcw,
  Server,
  Sliders,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import { useFlowStore } from '../store/useFlowStore';
import { checkServerHealth, type ServerHealthResult } from '../services/api';
import {
  listAudioInputDevices,
  requestMicrophonePermission,
  type MicDeviceOption,
} from '../services/audio';
import {
  DEFAULT_HANDS_FREE_HOTKEY,
  DEFAULT_PTT_HOTKEY,
  QUICK_HOTKEY_PRESETS,
  bindingFromKeyEvent,
  isModifierCode,
  isSameHotkeyBinding,
  normalizeEventCode,
} from '../services/hotkeys';
import { platform } from '../services/platform';
import type { DictationMode, HotkeyBinding } from '../types';

type SettingsTab = 'server' | 'shortcuts' | 'audio';

const ONE_COMMAND_INSTALL =
  'git clone https://github.com/<your-org>/crisptype.git && cd crisptype/backend && bash setup.sh';

export function SettingsModal() {
  const settingsOpen = useFlowStore((s) => s.settingsOpen);
  const setSettingsOpen = useFlowStore((s) => s.setSettingsOpen);
  const settings = useFlowStore((s) => s.settings);
  const updateSettings = useFlowStore((s) => s.updateSettings);
  const setIsCapturingHotkey = useFlowStore((s) => s.setIsCapturingHotkey);
  const clearHistory = useFlowStore((s) => s.clearHistory);
  const historyCount = useFlowStore((s) => s.history.length);
  const pushToast = useFlowStore((s) => s.pushToast);

  const [activeTab, setActiveTab] = useState<SettingsTab>('server');
  const [mics, setMics] = useState<MicDeviceOption[]>([
    { deviceId: 'default', label: 'System Default Microphone' },
  ]);
  const [capturingTarget, setCapturingTarget] = useState<DictationMode | null>(null);
  const [livePreviewLabel, setLivePreviewLabel] = useState<string>('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [showSelfHost, setShowSelfHost] = useState(false);
  const [copiedInstall, setCopiedInstall] = useState(false);
  const [pendingConflict, setPendingConflict] = useState<{
    target: DictationMode;
    binding: HotkeyBinding;
    shortcut: string;
    ownerName: string;
  } | null>(null);
  const [testingConn, setTestingConn] = useState(false);
  const [connStatus, setConnStatus] = useState<ServerHealthResult | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [requestingMic, setRequestingMic] = useState(false);

  useEffect(() => {
    setIsCapturingHotkey(capturingTarget !== null);
    if (!capturingTarget) {
      setLivePreviewLabel('');
    }
  }, [capturingTarget, setIsCapturingHotkey]);

  useEffect(() => {
    if (!settingsOpen) {
      setConnStatus(null);
      setConfirmClear(false);
      setCapturingTarget(null);
      setShowApiKey(false);
      return;
    }
    void listAudioInputDevices().then(setMics);
    void platform.getAutoStart().then((osAutoStart) => {
      if (typeof osAutoStart === 'boolean' && osAutoStart !== settings.launchAtStartup) {
        updateSettings({ launchAtStartup: osAutoStart });
      }
    });
  }, [settingsOpen, settings.launchAtStartup, updateSettings]);

  // Capture 1-key (e.g. Right Ctrl, fn), 2-key (e.g. Ctrl+Space, Ctrl+Alt), or 3-key combos
  useEffect(() => {
    if (!capturingTarget) return;

    let pendingModifierCombo: HotkeyBinding | null = null;

    const commitBinding = (binding: HotkeyBinding) => {
      setCapturingTarget(null);
      setLivePreviewLabel('');
      void tryApplyHotkey(capturingTarget, binding, false);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.code === 'Escape') {
        setCapturingTarget(null);
        return;
      }

      const candidate = bindingFromKeyEvent(e);
      setLivePreviewLabel(candidate.label);

      const code = normalizeEventCode(e);
      if (isModifierCode(code)) {
        // Hold candidate in case user adds a 2nd or 3rd key; commit on keyup if released solo/dual-mod
        pendingModifierCombo = candidate;
        return;
      }

      pendingModifierCombo = null;
      commitBinding(candidate);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (!pendingModifierCombo) return;
      const releasedCode = normalizeEventCode(e);
      if (isModifierCode(releasedCode) || releasedCode === pendingModifierCombo.code) {
        e.preventDefault();
        e.stopPropagation();
        const binding = pendingModifierCombo;
        pendingModifierCombo = null;
        commitBinding(binding);
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    window.addEventListener('keyup', handleKeyUp, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      window.removeEventListener('keyup', handleKeyUp, { capture: true });
    };
  }, [capturingTarget, updateSettings, pushToast]);

  if (!settingsOpen) return null;

  const handleConnect = async () => {
    setTestingConn(true);
    setConnStatus(null);
    const result = await checkServerHealth({
      baseUrl: settings.serverUrl,
      apiKey: settings.apiKey,
    });
    setConnStatus(result);
    setTestingConn(false);
    if (result.ok) {
      pushToast('Server connected', 'success');
    }
  };

  const handleRequestMicPermission = async () => {
    setRequestingMic(true);
    const result = await requestMicrophonePermission();
    const updatedMics = await listAudioInputDevices();
    setMics(updatedMics);
    setRequestingMic(false);
    pushToast(result.message, result.granted ? 'success' : 'error');
  };

  const handleCopyInstall = async () => {
    await platform.copyToClipboard(ONE_COMMAND_INSTALL);
    setCopiedInstall(true);
    pushToast('Setup command copied');
    setTimeout(() => setCopiedInstall(false), 1800);
  };

  const tryApplyHotkey = async (
    target: DictationMode,
    binding: HotkeyBinding,
    forceReplace = false
  ) => {
    if (target === 'hands_free' && platform.isTauriHost) {
      const res = await platform.applyNativeHotkeysChecked(
        {
          pushToTalk: settings.pushToTalkHotkey,
          handsFree: binding,
        },
        forceReplace
      );
      if (!res.applied && res.conflict) {
        setPendingConflict({
          target,
          binding,
          shortcut: res.conflict.shortcut || binding.label,
          ownerName: res.conflict.ownerName,
        });
        return;
      }
    }

    setPendingConflict(null);
    if (target === 'push_to_talk') {
      updateSettings({ pushToTalkHotkey: binding });
      pushToast(`Push-to-talk set to ${binding.label}`);
    } else {
      updateSettings({ handsFreeHotkey: binding });
      pushToast(`Hands-free set to ${binding.label}`);
    }
  };

  const applyHotkeyPreset = (target: DictationMode, binding: HotkeyBinding) => {
    setCapturingTarget(null);
    void tryApplyHotkey(target, binding, false);
  };

  const pttIsDefault = isSameHotkeyBinding(settings.pushToTalkHotkey, DEFAULT_PTT_HOTKEY);
  const handsFreeIsDefault = isSameHotkeyBinding(settings.handsFreeHotkey, DEFAULT_HANDS_FREE_HOTKEY);

  const TABS: Array<{ id: SettingsTab; label: string; icon: typeof Server }> = [
    { id: 'server', label: 'Server', icon: Server },
    { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
    { id: 'audio', label: 'Audio & App', icon: Sliders },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 backdrop-blur-[3px] p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) setSettingsOpen(false);
      }}
    >
      <div className="w-full max-w-[520px] max-h-[90vh] overflow-y-auto rounded-[22px] bg-[var(--flow-surface)] border border-[var(--flow-border)] shadow-2xl">
        {/* Minimal header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-3">
          <h2
            id="settings-modal-title"
            className="text-[18px] font-semibold tracking-[-0.015em] text-[var(--flow-text)]"
          >
            Settings
          </h2>
          <button
            type="button"
            onClick={() => setSettingsOpen(false)}
            aria-label="Close Settings"
            className="p-1.5 rounded-lg text-[var(--flow-text-muted)] hover:bg-[var(--flow-surface-hover)] hover:text-[var(--flow-text)] transition-colors cursor-pointer"
          >
            <X size={17} />
          </button>
        </div>

        {/* Clean segmented tab bar */}
        <div className="px-6 pb-4">
          <div
            role="tablist"
            aria-label="Settings sections"
            className="grid grid-cols-3 gap-1 p-1 rounded-[12px] bg-[var(--flow-surface-muted)] border border-[var(--flow-border-subtle)]"
          >
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => {
                    setActiveTab(tab.id);
                    setCapturingTarget(null);
                  }}
                  className={`flex items-center justify-center gap-1.5 rounded-[9px] py-1.5 text-[13px] font-medium transition-all cursor-pointer whitespace-nowrap ${
                    active
                      ? 'bg-[var(--flow-surface)] text-[var(--flow-text)] shadow-xs'
                      : 'text-[var(--flow-text-secondary)] hover:text-[var(--flow-text)]'
                  }`}
                >
                  <Icon size={14} strokeWidth={1.8} />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Tab body */}
        <div className="px-6 pb-6">
          {/* SERVER TAB */}
          {activeTab === 'server' && (
            <div className="space-y-4">
              <div className="space-y-3">
                <div>
                  <label
                    htmlFor="setting-server-url"
                    className="block text-[12px] font-medium text-[var(--flow-text-secondary)] mb-1.5"
                  >
                    Server link
                  </label>
                  <input
                    id="setting-server-url"
                    type="url"
                    value={settings.serverUrl}
                    onChange={(e) => {
                      updateSettings({ serverUrl: e.target.value });
                      setConnStatus(null);
                    }}
                    placeholder="https://your-server.example.com"
                    className="w-full h-10 rounded-[11px] border border-[var(--flow-border)] bg-[var(--flow-panel-bg)] dark:bg-[#191917] px-3.5 text-[13.5px] text-[var(--flow-text)] dark:text-[#F2F1EC] placeholder:text-[var(--flow-text-muted)] focus:outline-none focus:border-[var(--flow-accent)]"
                  />
                </div>

                <div>
                  <label
                    htmlFor="setting-api-key"
                    className="block text-[12px] font-medium text-[var(--flow-text-secondary)] mb-1.5"
                  >
                    API key{' '}
                    <span className="text-[var(--flow-text-muted)] font-normal">(optional)</span>
                  </label>
                  <div className="relative">
                    <input
                      id="setting-api-key"
                      type={showApiKey ? 'text' : 'password'}
                      value={settings.apiKey}
                      onChange={(e) => {
                        updateSettings({ apiKey: e.target.value });
                        setConnStatus(null);
                      }}
                      placeholder="Leave blank if your server is open"
                      className="w-full h-10 rounded-[11px] border border-[var(--flow-border)] bg-[var(--flow-panel-bg)] dark:bg-[#191917] pl-3.5 pr-10 text-[13.5px] text-[var(--flow-text)] dark:text-[#F2F1EC] placeholder:text-[var(--flow-text-muted)] focus:outline-none focus:border-[var(--flow-accent)]"
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey(!showApiKey)}
                      aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-[var(--flow-text-muted)] hover:text-[var(--flow-text)] cursor-pointer"
                    >
                      {showApiKey ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                </div>
              </div>

              {/* Primary connect action */}
              <div className="flex items-center justify-between gap-3 pt-0.5">
                <button
                  type="button"
                  onClick={() => void handleConnect()}
                  disabled={testingConn}
                  className="inline-flex items-center justify-center gap-2 rounded-[11px] bg-[var(--flow-primary-btn)] hover:bg-[var(--flow-primary-btn-hover)] text-[var(--flow-primary-btn-text)] px-4 h-9 text-[13px] font-medium transition-colors cursor-pointer disabled:opacity-60"
                >
                  {testingConn && <Loader2 size={14} className="animate-spin" />}
                  {testingConn ? 'Connecting…' : 'Connect'}
                </button>
              </div>

              {/* Connection feedback */}
              {connStatus && (
                <div
                  className={`rounded-[12px] px-3.5 py-2.5 text-[12.5px] space-y-1 ${
                    connStatus.ok
                      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20'
                      : 'bg-red-500/10 text-red-700 dark:text-red-300 border border-red-500/20'
                  }`}
                >
                  <div className="flex items-center gap-2 font-medium">
                    {connStatus.ok ? (
                      <CheckCircle2 size={14} className="shrink-0" />
                    ) : (
                      <AlertCircle size={14} className="shrink-0" />
                    )}
                    <span>{connStatus.message}</span>
                  </div>
                  {connStatus.ok && (connStatus.asrEngine || connStatus.vadEngine) && (
                    <p className="text-[11.5px] opacity-85 pl-5.5">
                      {[connStatus.asrEngine, connStatus.vadEngine, connStatus.llmProvider]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  )}
                </div>
              )}

              {/* Collapsible 1-command self-host helper */}
              <div className="pt-1 border-t border-[var(--flow-border-subtle)]">
                <button
                  type="button"
                  onClick={() => setShowSelfHost(!showSelfHost)}
                  aria-expanded={showSelfHost}
                  className="flex items-center justify-between w-full py-1.5 text-[12.5px] font-medium text-[var(--flow-text-secondary)] hover:text-[var(--flow-text)] transition-colors cursor-pointer"
                >
                  <span>Host your own server (Linux / Docker / Cloud VM)</span>
                  <ChevronDown
                    size={15}
                    className={`transition-transform duration-150 ${showSelfHost ? 'rotate-180' : ''}`}
                  />
                </button>

                {showSelfHost && (
                  <div className="mt-2 rounded-[12px] bg-[var(--flow-surface-muted)] border border-[var(--flow-border-subtle)] p-3 space-y-2">
                    <p className="text-[12px] leading-relaxed text-[var(--flow-text-secondary)]">
                      Run this single command on any Ubuntu/Debian Linux machine or cloud VM. It builds
                      native Silero VAD, generates an API key, and prints your Server URL to paste above.
                    </p>
                    <div className="flex items-center gap-2 rounded-[9px] bg-[var(--flow-surface)] border border-[var(--flow-border)] px-2.5 py-2">
                      <code className="flex-1 text-[11.5px] font-mono text-[var(--flow-text)] truncate select-all">
                        {ONE_COMMAND_INSTALL}
                      </code>
                      <button
                        type="button"
                        onClick={() => void handleCopyInstall()}
                        aria-label="Copy one-command install"
                        className="p-1 rounded-md text-[var(--flow-text-secondary)] hover:text-[var(--flow-text)] hover:bg-[var(--flow-surface-hover)] shrink-0 cursor-pointer"
                      >
                        {copiedInstall ? (
                          <Check size={14} className="text-emerald-600" />
                        ) : (
                          <Copy size={14} />
                        )}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* SHORTCUTS TAB */}
          {activeTab === 'shortcuts' && (
            <div className="space-y-4">
              <p className="text-[12px] text-[var(--flow-text-muted)]">
                Click a shortcut to record any 1-key (e.g. Right Ctrl), 2-key (Ctrl + Space), or 3-key
                (Ctrl + Alt + Space) binding, or pick a quick preset below.
              </p>

              <div className="rounded-[14px] border border-[var(--flow-border)] bg-[var(--flow-panel-bg)] divide-y divide-[var(--flow-border-subtle)]">
                {/* Push-to-talk row */}
                <div className="px-4 py-3.5 space-y-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[13.5px] font-medium text-[var(--flow-text)]">
                        Push-to-talk
                      </div>
                      <div className="text-[12px] text-[var(--flow-text-muted)]">
                        Hold to speak, release to paste
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {!pttIsDefault && (
                        <button
                          type="button"
                          onClick={() => applyHotkeyPreset('push_to_talk', DEFAULT_PTT_HOTKEY)}
                          aria-label="Reset Push-to-talk hotkey"
                          title="Reset to fn"
                          className="p-1.5 rounded-lg text-[var(--flow-text-muted)] hover:text-[var(--flow-text)] cursor-pointer"
                        >
                          <RotateCcw size={13} />
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label="Change Push-to-talk hotkey"
                        onClick={() =>
                          setCapturingTarget(
                            capturingTarget === 'push_to_talk' ? null : 'push_to_talk'
                          )
                        }
                        className={`min-w-[130px] h-8 px-3 rounded-[9px] border text-[12.5px] font-medium transition-colors cursor-pointer ${
                          capturingTarget === 'push_to_talk'
                            ? 'border-[var(--flow-accent)] bg-[var(--flow-accent-soft)] text-[var(--flow-accent)]'
                            : 'border-[var(--flow-border)] bg-[var(--flow-surface)] text-[var(--flow-text)] hover:border-[var(--flow-text-muted)]'
                        }`}
                      >
                        {capturingTarget === 'push_to_talk'
                          ? livePreviewLabel || 'Press 1, 2 or 3 keys…'
                          : settings.pushToTalkHotkey.label}
                      </button>
                    </div>
                  </div>

                  {/* Quick 1 / 2 / 3 key presets including Right Ctrl */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    {QUICK_HOTKEY_PRESETS.slice(0, 5).map((preset) => {
                      const active = isSameHotkeyBinding(settings.pushToTalkHotkey, preset.binding);
                      return (
                        <button
                          key={`ptt-${preset.label}`}
                          type="button"
                          onClick={() => applyHotkeyPreset('push_to_talk', preset.binding)}
                          className={`rounded-[7px] px-2 py-0.5 text-[11px] font-medium border transition-colors cursor-pointer ${
                            active
                              ? 'border-[var(--flow-accent)] bg-[var(--flow-accent-soft)] text-[var(--flow-accent)]'
                              : 'border-[var(--flow-border)] bg-[var(--flow-surface)] text-[var(--flow-text-secondary)] hover:text-[var(--flow-text)]'
                          }`}
                        >
                          {preset.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Hands-free row */}
                <div className="px-4 py-3.5 space-y-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[13.5px] font-medium text-[var(--flow-text)]">
                        Hands-free
                      </div>
                      <div className="text-[12px] text-[var(--flow-text-muted)]">
                        Press once to start, again or click ✓ to finish
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {!handsFreeIsDefault && (
                        <button
                          type="button"
                          onClick={() =>
                            applyHotkeyPreset('hands_free', DEFAULT_HANDS_FREE_HOTKEY)
                          }
                          aria-label="Reset Hands-free hotkey"
                          title="Reset to Ctrl + Alt + Space"
                          className="p-1.5 rounded-lg text-[var(--flow-text-muted)] hover:text-[var(--flow-text)] cursor-pointer"
                        >
                          <RotateCcw size={13} />
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label="Change Hands-free hotkey"
                        onClick={() =>
                          setCapturingTarget(capturingTarget === 'hands_free' ? null : 'hands_free')
                        }
                        className={`min-w-[130px] h-8 px-3 rounded-[9px] border text-[12.5px] font-medium transition-colors cursor-pointer ${
                          capturingTarget === 'hands_free'
                            ? 'border-[var(--flow-accent)] bg-[var(--flow-accent-soft)] text-[var(--flow-accent)]'
                            : 'border-[var(--flow-border)] bg-[var(--flow-surface)] text-[var(--flow-text)] hover:border-[var(--flow-text-muted)]'
                        }`}
                      >
                        {capturingTarget === 'hands_free'
                          ? livePreviewLabel || 'Press 1, 2 or 3 keys…'
                          : settings.handsFreeHotkey.label}
                      </button>
                    </div>
                  </div>

                  {/* Quick 1 / 2 / 3 key presets for Hands-free */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    {QUICK_HOTKEY_PRESETS.slice(1).map((preset) => {
                      const active = isSameHotkeyBinding(settings.handsFreeHotkey, preset.binding);
                      return (
                        <button
                          key={`hf-${preset.label}`}
                          type="button"
                          onClick={() => applyHotkeyPreset('hands_free', preset.binding)}
                          className={`rounded-[7px] px-2 py-0.5 text-[11px] font-medium border transition-colors cursor-pointer ${
                            active
                              ? 'border-[var(--flow-accent)] bg-[var(--flow-accent-soft)] text-[var(--flow-accent)]'
                              : 'border-[var(--flow-border)] bg-[var(--flow-surface)] text-[var(--flow-text-secondary)] hover:text-[var(--flow-text)]'
                          }`}
                        >
                          {preset.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div>
                <span className="block text-[12px] font-medium text-[var(--flow-text-secondary)] mb-1.5">
                  Primary mode
                </span>
                <div className="grid grid-cols-2 gap-1 p-1 rounded-[11px] bg-[var(--flow-surface-muted)] border border-[var(--flow-border-subtle)]">
                  <button
                    type="button"
                    onClick={() => updateSettings({ dictationMode: 'push_to_talk' })}
                    className={`rounded-[8px] py-1.5 text-[12.5px] font-medium transition-colors cursor-pointer ${
                      settings.dictationMode === 'push_to_talk'
                        ? 'bg-[var(--flow-surface)] text-[var(--flow-text)] shadow-xs'
                        : 'text-[var(--flow-text-secondary)] hover:text-[var(--flow-text)]'
                    }`}
                  >
                    Push-to-talk
                  </button>
                  <button
                    type="button"
                    onClick={() => updateSettings({ dictationMode: 'hands_free' })}
                    className={`rounded-[8px] py-1.5 text-[12.5px] font-medium transition-colors cursor-pointer ${
                      settings.dictationMode === 'hands_free'
                        ? 'bg-[var(--flow-surface)] text-[var(--flow-text)] shadow-xs'
                        : 'text-[var(--flow-text-secondary)] hover:text-[var(--flow-text)]'
                    }`}
                  >
                    Hands-free
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* AUDIO & APP TAB */}
          {activeTab === 'audio' && (
            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <label
                    htmlFor="setting-mic-device"
                    className="block text-[12px] font-medium text-[var(--flow-text-secondary)]"
                  >
                    Microphone
                  </label>
                  <button
                    type="button"
                    onClick={() => void handleRequestMicPermission()}
                    disabled={requestingMic}
                    className="inline-flex items-center gap-1 text-[11.5px] font-medium text-[var(--flow-accent)] hover:underline cursor-pointer disabled:opacity-50"
                  >
                    <Mic size={12} />
                    {requestingMic ? 'Checking mic…' : 'Allow mic access'}
                  </button>
                </div>
                <div className="relative">
                  <select
                    id="setting-mic-device"
                    value={settings.micDeviceId}
                    onChange={(e) => updateSettings({ micDeviceId: e.target.value })}
                    className="w-full h-10 appearance-none rounded-[11px] border border-[var(--flow-border)] bg-[var(--flow-panel-bg)] dark:bg-[#191917] pl-3.5 pr-9 text-[13px] text-[var(--flow-text)] dark:text-[#F2F1EC] focus:outline-none focus:border-[var(--flow-accent)] cursor-pointer"
                  >
                    {mics.map((mic) => (
                      <option
                        key={mic.deviceId}
                        value={mic.deviceId}
                        className="bg-[var(--flow-panel-bg)] text-[var(--flow-text)] dark:bg-[#191917] dark:text-[#F2F1EC]"
                      >
                        {mic.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    size={15}
                    aria-hidden="true"
                    className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--flow-text-muted)]"
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="setting-silence-timeout"
                  className="block text-[12px] font-medium text-[var(--flow-text-secondary)] mb-1.5"
                >
                  Hands-free silence stop
                </label>
                <div className="relative">
                  <select
                    id="setting-silence-timeout"
                    value={settings.silenceTimeoutSec}
                    onChange={(e) => updateSettings({ silenceTimeoutSec: Number(e.target.value) })}
                    className="w-full h-10 appearance-none rounded-[11px] border border-[var(--flow-border)] bg-[var(--flow-panel-bg)] dark:bg-[#191917] pl-3.5 pr-9 text-[13px] text-[var(--flow-text)] dark:text-[#F2F1EC] focus:outline-none focus:border-[var(--flow-accent)] cursor-pointer"
                  >
                    <option
                      value={0}
                      className="bg-[var(--flow-panel-bg)] text-[var(--flow-text)] dark:bg-[#191917] dark:text-[#F2F1EC]"
                    >
                      Manual stop only
                    </option>
                    <option
                      value={2}
                      className="bg-[var(--flow-panel-bg)] text-[var(--flow-text)] dark:bg-[#191917] dark:text-[#F2F1EC]"
                    >
                      2 seconds
                    </option>
                    <option
                      value={3}
                      className="bg-[var(--flow-panel-bg)] text-[var(--flow-text)] dark:bg-[#191917] dark:text-[#F2F1EC]"
                    >
                      3 seconds
                    </option>
                    <option
                      value={5}
                      className="bg-[var(--flow-panel-bg)] text-[var(--flow-text)] dark:bg-[#191917] dark:text-[#F2F1EC]"
                    >
                      5 seconds (default)
                    </option>
                    <option
                      value={8}
                      className="bg-[var(--flow-panel-bg)] text-[var(--flow-text)] dark:bg-[#191917] dark:text-[#F2F1EC]"
                    >
                      8 seconds
                    </option>
                  </select>
                  <ChevronDown
                    size={15}
                    aria-hidden="true"
                    className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--flow-text-muted)]"
                  />
                </div>
              </div>

              {/* Desktop Startup & System Tray */}
              <div className="space-y-3 pt-2 border-t border-[var(--flow-border-subtle)]">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[13px] font-medium text-[var(--flow-text)]">
                      Launch at startup
                    </div>
                    <div className="text-[12px] text-[var(--flow-text-muted)]">
                      Auto-start CrispType in the background when you sign in
                    </div>
                  </div>
                  <label className="inline-flex items-center cursor-pointer select-none shrink-0">
                    <input
                      type="checkbox"
                      checked={settings.launchAtStartup}
                      onChange={(e) => {
                        const enabled = e.target.checked;
                        updateSettings({ launchAtStartup: enabled });
                        pushToast(enabled ? 'Launch at startup enabled' : 'Launch at startup disabled');
                      }}
                      aria-label="Launch CrispType at startup"
                      className="sr-only peer"
                    />
                    <span className="relative w-9 h-5 rounded-full bg-[var(--flow-border)] peer-checked:bg-[var(--flow-accent)] transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:w-4 after:h-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-4" />
                  </label>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[13px] font-medium text-[var(--flow-text)]">
                      Run in system tray
                    </div>
                    <div className="text-[12px] text-[var(--flow-text-muted)]">
                      Keep global hotkeys &amp; floating popup active when window is closed
                    </div>
                  </div>
                  <label className="inline-flex items-center cursor-pointer select-none shrink-0">
                    <input
                      type="checkbox"
                      checked={settings.minimizeToTray}
                      onChange={(e) => {
                        const enabled = e.target.checked;
                        updateSettings({ minimizeToTray: enabled });
                        pushToast(enabled ? 'System tray background mode on' : 'System tray background mode off');
                      }}
                      aria-label="Keep CrispType running in system tray"
                      className="sr-only peer"
                    />
                    <span className="relative w-9 h-5 rounded-full bg-[var(--flow-border)] peer-checked:bg-[var(--flow-accent)] transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:w-4 after:h-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-4" />
                  </label>
                </div>
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-[var(--flow-border-subtle)]">
                <span className="text-[13px] font-medium text-[var(--flow-text)]">Appearance</span>
                <div className="inline-flex items-center gap-1 p-1 rounded-[10px] bg-[var(--flow-surface-muted)] border border-[var(--flow-border-subtle)]">
                  <button
                    type="button"
                    onClick={() => updateSettings({ theme: 'light' })}
                    className={`inline-flex items-center gap-1.5 rounded-[7px] px-2.5 py-1 text-[12px] font-medium cursor-pointer ${
                      settings.theme === 'light'
                        ? 'bg-[var(--flow-surface)] text-[var(--flow-text)] shadow-xs'
                        : 'text-[var(--flow-text-secondary)]'
                    }`}
                  >
                    <Sun size={13} />
                    Light
                  </button>
                  <button
                    type="button"
                    onClick={() => updateSettings({ theme: 'dark' })}
                    className={`inline-flex items-center gap-1.5 rounded-[7px] px-2.5 py-1 text-[12px] font-medium cursor-pointer ${
                      settings.theme === 'dark'
                        ? 'bg-[var(--flow-surface)] text-[var(--flow-text)] shadow-xs'
                        : 'text-[var(--flow-text-secondary)]'
                    }`}
                  >
                    <Moon size={13} />
                    Dark
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-[var(--flow-border-subtle)]">
                <div>
                  <div className="text-[13px] font-medium text-[var(--flow-text)]">Local history</div>
                  <div className="text-[12px] text-[var(--flow-text-muted)]">
                    {historyCount} {historyCount === 1 ? 'dictation' : 'dictations'} stored on this
                    device
                  </div>
                </div>
                {!confirmClear ? (
                  <button
                    type="button"
                    disabled={historyCount === 0}
                    onClick={() => setConfirmClear(true)}
                    className="inline-flex items-center gap-1.5 rounded-[9px] border border-red-500/30 px-3 py-1.5 text-[12px] font-medium text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer disabled:opacity-40"
                  >
                    <Trash2 size={13} />
                    Clear
                  </button>
                ) : (
                  <div className="inline-flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        void clearHistory();
                        setConfirmClear(false);
                      }}
                      className="rounded-[8px] bg-red-600 hover:bg-red-700 text-white px-2.5 py-1 text-[12px] font-medium cursor-pointer"
                    >
                      Delete all
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmClear(false)}
                      className="rounded-[8px] border border-[var(--flow-border)] px-2.5 py-1 text-[12px] text-[var(--flow-text-secondary)] cursor-pointer"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      {/* Settings modal & conflict confirmation */}
      {pendingConflict && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-[2px] p-4"
          role="alertdialog"
          aria-modal="true"
        >
          <div className="w-full max-w-[400px] rounded-[18px] bg-[var(--flow-surface)] border border-[var(--flow-border)] p-5 shadow-2xl space-y-4">
            <div className="space-y-1.5">
              <h3 className="text-[15px] font-semibold text-[var(--flow-text)]">
                Shortcut Already In Use
              </h3>
              <p className="text-[13px] text-[var(--flow-text-secondary)] leading-relaxed">
                <span className="font-medium text-[var(--flow-text)]">{pendingConflict.shortcut}</span>{' '}
                is already assigned to{' '}
                <span className="font-medium text-[var(--flow-text)]">{pendingConflict.ownerName}</span>.
                Do you want to replace it and assign it to CrispType?
              </p>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingConflict(null)}
                className="px-3.5 py-1.5 rounded-[10px] text-[13px] font-medium border border-[var(--flow-border)] text-[var(--flow-text-secondary)] hover:bg-[var(--flow-surface-hover)] cursor-pointer"
              >
                Keep Previous
              </button>
              <button
                type="button"
                onClick={() =>
                  void tryApplyHotkey(pendingConflict.target, pendingConflict.binding, true)
                }
                className="px-3.5 py-1.5 rounded-[10px] text-[13px] font-medium bg-[var(--flow-accent)] text-white hover:opacity-90 cursor-pointer"
              >
                Replace Shortcut
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
