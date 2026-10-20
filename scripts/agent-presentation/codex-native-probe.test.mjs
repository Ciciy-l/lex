import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isolatedEnvironment, fixturePrompt } from './codex-native-probe.mjs';

test('isolates native Codex environment and never inherits credentials or injection', () => {
  const parent = { PATH: 'bin', SystemRoot: 'system', HOME: 'real', CODEX_HOME: 'real-codex',
    OPENAI_API_KEY: 'fixture-never-inherit', HTTPS_PROXY: 'fixture-proxy', NODE_OPTIONS: '--require bad',
    CODEX_CONFIG: 'fixture-injection', LEX_PROBE_TOKEN: 'old-token' };
  const env = isolatedEnvironment(parent, path.resolve('fixture-home'));
  assert.equal(env.PATH, 'bin');
  assert.equal(env.CODEX_HOME, path.join(path.resolve('fixture-home'), '.codex'));
  for (const key of ['OPENAI_API_KEY', 'HTTPS_PROXY', 'NODE_OPTIONS', 'CODEX_CONFIG', 'LEX_PROBE_TOKEN']) {
    assert.equal(env[key], undefined);
  }
  assert.equal(parent.HOME, 'real');
});

test('auxiliary title requests and earlier input cannot count as main turns', () => {
  const message = text => ({ role: 'user', content: [{ type: 'input_text', text }] });
  assert.equal(fixturePrompt([message('LEX_TUI_SECOND')]), 'LEX_TUI_SECOND');
  assert.equal(fixturePrompt([message('LEX_TUI_SECOND'), message('Title for LEX_TUI_SECOND')]), null);
  assert.equal(fixturePrompt([{ role: 'assistant', content: [{ text: 'LEX_GUI_FIRST' }] }]), null);
  assert.equal(fixturePrompt(undefined), null);
});
