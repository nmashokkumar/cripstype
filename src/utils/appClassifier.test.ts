import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_STYLES_BY_CONTEXT,
  classifyAppContext,
  resolveStylePresetForCategory,
} from './appClassifier.ts';

test('classifies email clients across desktop, web, and mobile identifiers', () => {
  assert.deepEqual(classifyAppContext('com.google.android.gm'), {
    appName: 'Gmail',
    category: 'email',
    rawIdentifier: 'com.google.android.gm',
  });
  assert.equal(classifyAppContext('chrome.exe', 'Inbox (3) - Gmail - Google Chrome').category, 'email');
  assert.equal(classifyAppContext('chrome.exe', 'Inbox (3) - Gmail - Google Chrome').appName, 'Gmail');
  assert.equal(classifyAppContext('OUTLOOK.EXE').category, 'email');
  assert.equal(classifyAppContext('thunderbird').category, 'email');
  assert.equal(classifyAppContext('com.apple.mail').category, 'email');
});

test('classifies personal messaging apps across Windows, macOS, Linux, and Android', () => {
  assert.equal(classifyAppContext('com.whatsapp').appName, 'WhatsApp');
  assert.equal(classifyAppContext('com.whatsapp').category, 'personal');
  assert.equal(classifyAppContext('TelegramDesktop').category, 'personal');
  assert.equal(classifyAppContext('Signal').category, 'personal');
  assert.equal(classifyAppContext('Discord.exe').category, 'personal');
});

test('classifies work tools and IDEs into work context', () => {
  assert.equal(classifyAppContext('Slack').category, 'work');
  assert.equal(classifyAppContext('ms-teams.exe').category, 'work');
  assert.equal(classifyAppContext('code.exe').appName, 'VS Code');
  assert.equal(classifyAppContext('code.exe').category, 'work');
  assert.equal(classifyAppContext('Notion').category, 'work');
});

test('falls back cleanly for unknown apps and resolves style presets', () => {
  const unknown = classifyAppContext('obsidian.exe');
  assert.equal(unknown.appName, 'Obsidian');
  assert.equal(unknown.category, 'other');

  assert.equal(resolveStylePresetForCategory('email', DEFAULT_STYLES_BY_CONTEXT), 'formal');
  assert.equal(resolveStylePresetForCategory('personal', DEFAULT_STYLES_BY_CONTEXT), 'very_casual');
  assert.equal(resolveStylePresetForCategory('work', { work: 'formal' }), 'formal');
});
