import type { StyleContext, StylePreset } from '../types';

export interface DetectedAppContext {
  /** Human-readable application name (e.g. "Gmail", "WhatsApp", "Slack", "Browser") */
  appName: string;
  /** Semantic category used to pick the matching Style preset and Layer 2 LLM prompt */
  category: StyleContext;
  /** Raw OS window/process/package identifier when supplied by a native wrapper */
  rawIdentifier?: string;
}

export const DEFAULT_STYLES_BY_CONTEXT: Record<StyleContext, StylePreset> = {
  email: 'formal',
  work: 'casual',
  personal: 'very_casual',
  other: 'formal',
};

interface AppRule {
  category: StyleContext;
  canonicalName: string;
  patterns: RegExp[];
}

/**
 * Cross-platform application matcher covering Windows (.exe), macOS bundle names,
 * Linux WM_CLASS, Android package names (com.*), iOS bundles, and web titles.
 */
const APP_CLASSIFICATION_RULES: AppRule[] = [
  // Email clients -> formal
  {
    category: 'email',
    canonicalName: 'Gmail',
    patterns: [/\bgmail\b/i, /com\.google\.android\.gm/i, /mail\.google\.com/i],
  },
  {
    category: 'email',
    canonicalName: 'Outlook',
    patterns: [/\boutlook\b/i, /com\.microsoft\.office\.outlook/i, /olk\.exe/i],
  },
  {
    category: 'email',
    canonicalName: 'Thunderbird',
    patterns: [/\bthunderbird\b/i, /org\.mozilla\.thunderbird/i],
  },
  {
    category: 'email',
    canonicalName: 'Apple Mail',
    patterns: [/\bapple\s*mail\b/i, /com\.apple\.mail/i, /^mail$/i],
  },
  {
    category: 'email',
    canonicalName: 'Superhuman',
    patterns: [/\bsuperhuman\b/i],
  },
  {
    category: 'email',
    canonicalName: 'Proton Mail',
    patterns: [/\bproton\s*mail\b/i, /ch\.protonmail/i, /mail\.proton/i],
  },
  {
    category: 'email',
    canonicalName: 'Spark',
    patterns: [/\bspark\s*mail\b/i, /com\.readdle\.spark/i],
  },
  {
    category: 'email',
    canonicalName: 'Fastmail',
    patterns: [/\bfastmail\b/i],
  },

  // Personal messaging -> very_casual / personal
  {
    category: 'personal',
    canonicalName: 'WhatsApp',
    patterns: [/whatsapp/i, /com\.whatsapp/i, /web\.whatsapp/i],
  },
  {
    category: 'personal',
    canonicalName: 'Telegram',
    patterns: [/telegram/i, /org\.telegram\.messenger/i],
  },
  {
    category: 'personal',
    canonicalName: 'Signal',
    patterns: [/\bsignal\b/i, /signaldesktop/i, /org\.thoughtcrime\.securesms/i],
  },
  {
    category: 'personal',
    canonicalName: 'iMessage',
    patterns: [/imessage/i, /com\.apple\.mobilesms/i, /\bmessages\b/i],
  },
  {
    category: 'personal',
    canonicalName: 'Discord',
    patterns: [/discord/i, /com\.discord/i],
  },
  {
    category: 'personal',
    canonicalName: 'Messenger',
    patterns: [/\bmessenger\b/i, /com\.facebook\.orca/i],
  },
  {
    category: 'personal',
    canonicalName: 'Instagram',
    patterns: [/\binstagram\b/i, /com\.instagram\.android/i],
  },
  {
    category: 'personal',
    canonicalName: 'Snapchat',
    patterns: [/\bsnapchat\b/i, /com\.snapchat/i],
  },

  // Work & productivity messaging / editors -> work
  {
    category: 'work',
    canonicalName: 'Slack',
    patterns: [/\bslack\b/i, /com\.slack/i, /com\.tinyspeck\.slackmacgap/i],
  },
  {
    category: 'work',
    canonicalName: 'Microsoft Teams',
    patterns: [/\bteams\b/i, /ms-teams/i, /com\.microsoft\.teams/i],
  },
  {
    category: 'work',
    canonicalName: 'Google Chat',
    patterns: [/\bgoogle\s*chat\b/i, /chat\.google\.com/i, /com\.google\.android\.apps\.dynamite/i],
  },
  {
    category: 'work',
    canonicalName: 'Zoom',
    patterns: [/\bzoom\b/i, /us\.zoom/i],
  },
  {
    category: 'work',
    canonicalName: 'Linear',
    patterns: [/\blinear\b/i],
  },
  {
    category: 'work',
    canonicalName: 'Jira',
    patterns: [/\bjira\b/i, /atlassian/i],
  },
  {
    category: 'work',
    canonicalName: 'Notion',
    patterns: [/\bnotion\b/i, /notion\.so/i],
  },
  {
    category: 'work',
    canonicalName: 'VS Code',
    patterns: [/\bvs\s*code\b/i, /\bvisual\s*studio\s*code\b/i, /^code(\.exe)?$/i, /com\.microsoft\.vscode/i],
  },
  {
    category: 'work',
    canonicalName: 'Cursor',
    patterns: [/\bcursor\b/i],
  },
  {
    category: 'work',
    canonicalName: 'GitHub',
    patterns: [/\bgithub\b/i],
  },
  {
    category: 'work',
    canonicalName: 'Google Docs',
    patterns: [/\bgoogle\s*docs\b/i, /docs\.google\.com/i],
  },
  {
    category: 'work',
    canonicalName: 'Figma',
    patterns: [/\bfigma\b/i],
  },
];

function prettifyFallbackName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/\.exe$/i, '')
    .replace(/\.app$/i, '')
    .replace(/^com\.[^.]+\./i, '')
    .replace(/^org\.[^.]+\./i, '')
    .replace(/[_-]+/g, ' ')
    .trim();

  if (!cleaned) return 'Desktop';
  return cleaned
    .split(/\s+/)
    .slice(0, 3)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Classifies any raw OS process name, window title, Android package ID, or display name
 * into a normalized `{ appName, category }` pair for style-aware LLM refinement.
 */
export function classifyAppContext(
  rawAppName?: string | null,
  windowTitle?: string | null
): DetectedAppContext {
  const appStr = (rawAppName ?? '').trim();
  const titleStr = (windowTitle ?? '').trim();
  const haystack = `${appStr} ${titleStr}`.trim();

  if (!haystack) {
    return { appName: 'Desktop', category: 'other' };
  }

  for (const rule of APP_CLASSIFICATION_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(haystack))) {
      return {
        appName: rule.canonicalName,
        category: rule.category,
        rawIdentifier: appStr || titleStr,
      };
    }
  }

  // Generic keyword heuristics for unknown mail / chat apps
  if (/\b(mail|inbox|webmail|compose\s+email)\b/i.test(haystack)) {
    return {
      appName: prettifyFallbackName(appStr || 'Mail'),
      category: 'email',
      rawIdentifier: appStr || titleStr,
    };
  }
  if (/\b(sms|chat|dm|direct\s+message)\b/i.test(haystack)) {
    return {
      appName: prettifyFallbackName(appStr || 'Messages'),
      category: 'personal',
      rawIdentifier: appStr || titleStr,
    };
  }

  return {
    appName: prettifyFallbackName(appStr || titleStr),
    category: 'other',
    rawIdentifier: appStr || titleStr,
  };
}

/**
 * Resolves the effective Layer 2 style preset for a detected app category using
 * the user's configured Style preferences.
 */
export function resolveStylePresetForCategory(
  category: StyleContext,
  stylesByContext?: Partial<Record<StyleContext, StylePreset>>
): StylePreset {
  return stylesByContext?.[category] ?? DEFAULT_STYLES_BY_CONTEXT[category] ?? 'formal';
}
