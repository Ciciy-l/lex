import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixturePrompt } from './extension-native-probe.mjs';

test('recognizes fixture input with native metadata prefix, not a mention elsewhere', () => {
  assert.equal(fixturePrompt('LEX_GUI_FIRST'), 'LEX_GUI_FIRST');
  assert.equal(fixturePrompt('<system-reminder>native fixture context</system-reminder>\nLEX_GUI_FIRST'), 'LEX_GUI_FIRST');
  assert.equal(fixturePrompt([{ type: 'text', text: 'LEX_TUI_THIRD' }]), 'LEX_TUI_THIRD');
  assert.equal(fixturePrompt('Title for LEX_GUI_FIRST'), null);
  assert.equal(fixturePrompt('LEX_GUI_FIRST\nother content'), null);
  assert.equal(fixturePrompt(undefined), null);
});
