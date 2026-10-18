import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeTerminal } from './terminal-observation.mjs';

test('preserves text across split CSI and OSC sequences without exposing title payload', () => {
  const state = { mode: 'text' };
  const chunks = ['before' + String.fromCharCode(27) + '[31', 'mred',
    String.fromCharCode(27) + ']0;hidden title', String.fromCharCode(27),
    String.fromCharCode(92) + 'after'];
  assert.equal(chunks.map(chunk => observeTerminal(state, chunk)).join(''), 'beforeredafter');
  assert.equal(state.mode, 'text');
});

test('handles a long unterminated terminal control string without buffering it', () => {
  const state = { mode: 'text' };
  assert.equal(observeTerminal(state, String.fromCharCode(27) + ']'), '');
  assert.equal(observeTerminal(state, 'X'.repeat(500_000)), '');
  assert.deepEqual(Object.keys(state).sort(), ['escape', 'mode']);
  assert.equal(observeTerminal(state, String.fromCharCode(7) + 'visible'), 'visible');
});

test('retains Unicode response and line breaks while removing styling and bell', () => {
  const state = { mode: 'text' };
  const esc = String.fromCharCode(27);
  assert.equal(observeTerminal(state, esc + '[1m回答' + esc + '[0m' + String.fromCharCode(7, 10) + 'ok'), '回答\nok');
});
