import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { isolatedEnvironment, observedPartialTranscript } from './claude-native-probe.mjs';

test('native probe strips inherited identity, proxies and code injection without mutating the host', () => {
  const parent = Object.freeze({ Path: 'fake-os-path', SystemRoot: 'fake-os-root',
    HOME: 'private-home', USERPROFILE: 'private-profile', APPDATA: 'private-app-data',
    CLAUDE_CONFIG_DIR: 'private-agent-home', CLAUDE_CODE_OAUTH_TOKEN: 'private-oauth',
    ANTHROPIC_AUTH_TOKEN: 'private-bearer', ANTHROPIC_API_KEY: 'private-key',
    ANTHROPIC_BASE_URL: 'https://private-provider.invalid',
    HTTP_PROXY: 'private-proxy', HTTPS_PROXY: 'private-proxy',
    NODE_OPTIONS: '--require private-module', GIT_CONFIG_GLOBAL: 'private-git-config' });
  const fixtureHome = path.resolve('synthetic-home');
  const env = isolatedEnvironment(parent, fixtureHome, 'http://127.0.0.1:1234');
  assert.equal(env.Path, 'fake-os-path');
  assert.equal(env.SystemRoot, 'fake-os-root');
  assert.equal(env.HOME, fixtureHome);
  assert.equal(env.USERPROFILE, fixtureHome);
  assert.equal(env.CLAUDE_CONFIG_DIR, path.join(fixtureHome, '.claude'));
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:1234');
  assert.equal(Object.values(env).some((value) => value.includes('private-')), false);
  assert.equal(parent.ANTHROPIC_API_KEY, 'private-key');
});

function report(at, { type = 'assistant', sessionId = 'native-1', completedAt = 4000 } = {}) {
  return { nativeSessionId: 'native-1',
    streams: [{ marker: 'LEX_FIRST_RESULT', isMain: true, firstDeltaAt: 1000, completedAt }],
    transcripts: [{ at, record: { type, sessionId,
      message: { content: [{ type: 'text', text: 'LEX_FIRST_RESULT' }] } } }] };
}

test('completed transcript and reflected user content cannot establish live assistant streaming', () => {
  assert.equal(observedPartialTranscript(report(4000)), false);
  assert.equal(observedPartialTranscript(report(4500)), false);
  assert.equal(observedPartialTranscript(report(900)), false);
  assert.equal(observedPartialTranscript(report(2000, { type: 'user' })), false);
  assert.equal(observedPartialTranscript(report(2000, { sessionId: 'different-session' })), false);
  assert.equal(observedPartialTranscript(report(2000, { completedAt: null })), false);
  assert.equal(observedPartialTranscript(report(2000)), true);
});
