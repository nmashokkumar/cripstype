import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { useFlowStore } from '../store/useFlowStore';
import type { StyleContext, StylePreset } from '../types';

const STYLE_TABS: Array<{ id: StyleContext; label: string }> = [
  { id: 'personal', label: 'Personal messages' },
  { id: 'work', label: 'Work messages' },
  { id: 'email', label: 'Email' },
  { id: 'other', label: 'Other' },
];

const CONTEXT_DETAILS: Record<
  StyleContext,
  {
    headlinePrefix: string;
    headlineItalic: string;
    description: string;
    detectedApps: string[];
    previews: Record<'formal' | 'casual' | 'very_casual', { body: string }>;
  }
> = {
  personal: {
    headlinePrefix: 'Sound like ',
    headlineItalic: 'yourself',
    description:
      'Automatically applied whenever CrispType detects personal messaging apps — no manual tagging needed.',
    detectedApps: ['WhatsApp', 'Telegram', 'Signal', 'iMessage', 'Discord', 'Messenger'],
    previews: {
      formal: {
        body: 'Hey! Are you free for dinner tonight? Let me know what time works best for you.',
      },
      casual: {
        body: 'Hey, are you free for dinner tonight? Let me know what time works best',
      },
      very_casual: {
        body: 'hey are you free for dinner tonight? lmk what time works best',
      },
    },
  },
  work: {
    headlinePrefix: 'Clear and sharp at ',
    headlineItalic: 'work',
    description:
      'Automatically applied when dictating inside team chat, docs, and developer tools.',
    detectedApps: ['Slack', 'Microsoft Teams', 'VS Code', 'Cursor', 'Notion', 'Linear'],
    previews: {
      formal: {
        body: 'Hi team, I pushed the fix for the streaming pipeline. Could someone review the pull request before 4 PM?',
      },
      casual: {
        body: 'Hey team, I pushed the fix for the streaming pipeline. Can someone review the PR before 4 pm?',
      },
      very_casual: {
        body: 'hey team pushed the streaming pipeline fix, can someone review the pr before 4?',
      },
    },
  },
  email: {
    headlinePrefix: 'Polished emails, ',
    headlineItalic: 'effortlessly',
    description:
      'Automatically applied when composing messages in desktop, web, or mobile mail clients.',
    detectedApps: ['Gmail', 'Outlook', 'Apple Mail', 'Thunderbird', 'Superhuman', 'Proton Mail'],
    previews: {
      formal: {
        body: 'Hi Sarah,\n\nCould you send over the quarterly report by Friday? Please let me know if you need anything else from my side.\n\nBest,',
      },
      casual: {
        body: 'Hey Sarah,\n\nCan you send the quarterly report by Friday? Let me know if you need anything else from me.',
      },
      very_casual: {
        body: 'hey sarah, can you send the quarterly report by friday? let me know if you need anything else',
      },
    },
  },
  other: {
    headlinePrefix: 'Consistent voice ',
    headlineItalic: 'everywhere',
    description:
      'Default tone used for browsers, notes, documents, and any other application on your device.',
    detectedApps: ['Browsers', 'Notes', 'Documents', 'All other apps'],
    previews: {
      formal: {
        body: 'The meeting has moved to 3 PM tomorrow. Can everyone bring their updated slides?',
      },
      casual: {
        body: 'The meeting moved to 3 pm tomorrow. Can everyone bring their updated slides?',
      },
      very_casual: {
        body: 'the meeting moved to 3 pm tomorrow, can everyone bring their slides?',
      },
    },
  },
};

const STYLE_CARDS: Array<{
  id: 'formal' | 'casual' | 'very_casual';
  title: string;
  subtitle: string;
}> = [
  {
    id: 'formal',
    title: 'Formal',
    subtitle: 'Caps + Punctuation',
  },
  {
    id: 'casual',
    title: 'Casual',
    subtitle: 'Caps + Less punctuation',
  },
  {
    id: 'very_casual',
    title: 'Very casual',
    subtitle: 'No caps + Less punctuation',
  },
];

export function StylePage() {
  const stylesByContext = useFlowStore((s) => s.stylesByContext);
  const setStylePreset = useFlowStore((s) => s.setStylePreset);
  const dismissed = useFlowStore((s) => s.dismissed);
  const dismissBanner = useFlowStore((s) => s.dismissBanner);
  const pushToast = useFlowStore((s) => s.pushToast);

  const [activeTab, setActiveTab] = useState<StyleContext>('personal');

  const contextInfo = CONTEXT_DETAILS[activeTab];
  const selectedPreset: StylePreset = stylesByContext[activeTab] ?? 'formal';

  return (
    <div className="max-w-[920px] mx-auto w-full px-6 md:px-10 pt-8 pb-24 space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-semibold tracking-[-0.02em] text-[var(--flow-text)]">
            Style
          </h1>
          <p className="mt-1 text-[13.5px] text-[var(--flow-text-muted)]">
            CrispType detects your active app automatically and applies the matching tone on your server
          </p>
        </div>
      </div>

      {/* Category tabs */}
      <div
        role="tablist"
        aria-label="Style categories"
        className="flex items-center gap-6 overflow-x-auto border-b border-[var(--flow-border)]"
      >
        {STYLE_TABS.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTab(tab.id)}
              className={`relative pb-3 text-[14px] whitespace-nowrap transition-colors cursor-pointer inline-flex items-center gap-1.5 ${
                active
                  ? 'text-[var(--flow-text)] font-medium'
                  : 'text-[var(--flow-text-muted)] hover:text-[var(--flow-text)]'
              }`}
            >
              <span>{tab.label}</span>
              {active && (
                <span className="absolute bottom-0 left-0 right-0 h-[2px] rounded-full bg-[var(--flow-text)]" />
              )}
            </button>
          );
        })}
      </div>

      <div className="space-y-6">
        {/* Context hero banner */}
        {!dismissed.styleBanner && (
          <section className="banner-style relative overflow-hidden rounded-[18px] px-7 py-6 text-white shadow-xs">
            <button
              type="button"
              onClick={() => dismissBanner('styleBanner')}
              aria-label="Dismiss style banner"
              className="absolute top-3.5 right-3.5 w-7 h-7 rounded-full bg-black/25 hover:bg-black/40 flex items-center justify-center text-white/85 transition-colors cursor-pointer"
            >
              <X size={14} />
            </button>

            <h2 className="font-serif-display text-[25px] md:text-[27px] font-normal tracking-[-0.01em] text-white leading-snug pr-8">
              {contextInfo.headlinePrefix}
              <em className="italic">{contextInfo.headlineItalic}</em>.
            </h2>
            <p className="mt-1.5 text-[13.5px] text-white/85 max-w-[540px] leading-relaxed">
              {contextInfo.description}
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              {contextInfo.detectedApps.map((app) => (
                <span
                  key={app}
                  className="rounded-[8px] bg-white/15 backdrop-blur-xs px-2.5 py-1 text-[12px] font-medium text-white/95"
                >
                  {app}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* 3 selectable style cards */}
        <div
          role="radiogroup"
          aria-label={`${STYLE_TABS.find((t) => t.id === activeTab)?.label ?? 'Style'} tone preset`}
          className="grid grid-cols-1 md:grid-cols-3 gap-4"
        >
          {STYLE_CARDS.map((card) => {
            const isSelected = selectedPreset === card.id;
            const preview = contextInfo.previews[card.id];
            return (
              <button
                key={card.id}
                type="button"
                role="radio"
                aria-checked={isSelected}
                onClick={() => {
                  setStylePreset(activeTab, card.id);
                  pushToast(
                    `${STYLE_TABS.find((t) => t.id === activeTab)?.label} set to ${card.title}`
                  );
                }}
                className={`group text-left rounded-[18px] p-5 transition-all cursor-pointer flex flex-col justify-between min-h-[210px] border-2 ${
                  isSelected
                    ? 'border-[var(--flow-accent)] bg-[var(--flow-surface)] shadow-sm'
                    : 'border-[var(--flow-border)] bg-[var(--flow-surface)] hover:border-[var(--flow-text-muted)]/60'
                }`}
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="text-[16px] font-semibold text-[var(--flow-text)]">
                        {card.title}
                      </h3>
                      <p className="text-[12.5px] text-[var(--flow-text-muted)] mt-0.5">
                        {card.subtitle}
                      </p>
                    </div>
                    <span
                      className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                        isSelected
                          ? 'bg-[var(--flow-accent)] text-white'
                          : 'border border-[var(--flow-border)] bg-transparent'
                      }`}
                    >
                      {isSelected && <Check size={12} strokeWidth={3} />}
                    </span>
                  </div>

                  <div className="mt-4 rounded-[12px] bg-[var(--flow-style-bubble-bg)] border border-[var(--flow-border-subtle)] p-3.5">
                    <p className="text-[13px] leading-[1.55] text-[var(--flow-text-secondary)] whitespace-pre-line">
                      {preview.body}
                    </p>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
