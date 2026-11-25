import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_HANDS_FREE_HOTKEY,
  DEFAULT_PTT_HOTKEY,
  bindingFromKeyEvent,
  formatHotkeyBinding,
  matchesHotkeyDown,
  matchesHotkeyRelease,
} from './hotkeys.ts';

test('default hotkeys match fn for push-to-talk and Ctrl + Alt + Space for hands-free', () => {
  assert.equal(DEFAULT_PTT_HOTKEY.code, 'Fn');
  assert.equal(DEFAULT_PTT_HOTKEY.label, 'fn');

  assert.equal(DEFAULT_HANDS_FREE_HOTKEY.code, 'Space');
  assert.equal(DEFAULT_HANDS_FREE_HOTKEY.ctrl, true);
  assert.equal(DEFAULT_HANDS_FREE_HOTKEY.alt, true);
  assert.equal(DEFAULT_HANDS_FREE_HOTKEY.label, 'Ctrl + Alt + Space');
});

test('formats 1-key, 2-key, and 3-key shortcuts cleanly', () => {
  assert.equal(formatHotkeyBinding({ code: 'Fn' }), 'fn');
  assert.equal(formatHotkeyBinding({ code: 'ControlRight' }), 'Right Ctrl');
  assert.equal(formatHotkeyBinding({ code: 'Space', ctrl: true }), 'Ctrl + Space');
  assert.equal(formatHotkeyBinding({ code: 'AltRight', ctrl: true }), 'Ctrl + Right Alt');
  assert.equal(formatHotkeyBinding({ code: 'Space', ctrl: true, alt: true }), 'Ctrl + Alt + Space');
  assert.equal(formatHotkeyBinding({ code: 'KeyD', ctrl: true, shift: true }), 'Ctrl + Shift + D');
});

test('Right Ctrl matches ControlRight exclusively and distinguishes Left Ctrl', () => {
  const rightCtrl = bindingFromKeyEvent({
    code: 'ControlRight',
    key: 'Control',
    location: 2,
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    metaKey: false,
  });

  assert.equal(rightCtrl.code, 'ControlRight');
  assert.equal(rightCtrl.label, 'Right Ctrl');

  assert.equal(
    matchesHotkeyDown(
      { code: 'ControlRight', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false },
      rightCtrl
    ),
    true
  );
  assert.equal(
    matchesHotkeyDown(
      { code: 'ControlLeft', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false },
      rightCtrl
    ),
    false
  );
  assert.equal(
    matchesHotkeyRelease(
      { code: 'ControlRight', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false },
      rightCtrl
    ),
    true
  );
  assert.equal(
    matchesHotkeyRelease(
      { code: 'ControlLeft', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false },
      rightCtrl
    ),
    false
  );
});

test('supports 2-key modifier combos like Ctrl + Right Alt', () => {
  const twoModCombo = bindingFromKeyEvent({
    code: 'AltRight',
    key: 'Alt',
    ctrlKey: true,
    altKey: true,
    shiftKey: false,
    metaKey: false,
  });
  assert.equal(twoModCombo.label, 'Ctrl + Right Alt');
  assert.equal(
    matchesHotkeyDown(
      { code: 'AltRight', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false },
      twoModCombo
    ),
    true
  );
  assert.equal(
    matchesHotkeyDown(
      { code: 'AltRight', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false },
      twoModCombo
    ),
    false
  );
});

test('matchesHotkeyDown requires exact modifier match for combos and single keys', () => {
  const comboEvent = { code: 'Space', key: ' ', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false };
  const spaceOnlyEvent = { code: 'Space', key: ' ', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
  const extraShiftEvent = { code: 'Space', key: ' ', ctrlKey: true, altKey: true, shiftKey: true, metaKey: false };

  assert.equal(matchesHotkeyDown(comboEvent, DEFAULT_HANDS_FREE_HOTKEY), true);
  assert.equal(matchesHotkeyDown(spaceOnlyEvent, DEFAULT_HANDS_FREE_HOTKEY), false);
  assert.equal(matchesHotkeyDown(extraShiftEvent, DEFAULT_HANDS_FREE_HOTKEY), false);

  const fnEvent = { code: 'Fn', key: 'Fn', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
  assert.equal(matchesHotkeyDown(fnEvent, DEFAULT_PTT_HOTKEY), true);
});
