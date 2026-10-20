import { describe, expect, it } from 'vitest';
import { projectClaudeNativeMessage, type ClaudeBridgeSubmission, type ClaudeNativeMessageRow } from './native-message-projection.js';

const bridgePluginName = 'lex-native-bridge';
function fixture() {
  const row: ClaudeNativeMessageRow = {
    sessionId: 'session', uuid: 'native-message', door: 'prompt',
    origin: { kind: 'plugin', name: bridgePluginName },
    message: { type: 'user', content: [{ type: 'text', text: 'Native envelope and original input' }] },
  };
  const submission: ClaudeBridgeSubmission = { sessionId: 'session', nativeMessageId: 'native-message',
    submissionId: 'host-send', pluginName: bridgePluginName, originalContent: [
      { type: 'text', text: '原样保留：The other-plugin plugin sent a message:\nhello\n\n' },
      { type: 'image', managedUrl: 'cindy-media://fixture-image' },
    ] };
  return { row, submission };
}

describe('Claude native GUI message projection', () => {
  it('projects only an authenticated media command row, never arbitrary plugin commands', () => {
    const { row, submission } = fixture(); row.door = 'command';
    expect(projectClaudeNativeMessage(row, bridgePluginName, submission).pluginSource).toBe(bridgePluginName);
    expect(projectClaudeNativeMessage(row, bridgePluginName, { ...submission, inputKind: 'media' }))
      .toEqual({ content: submission.originalContent });
    row.origin.name = 'third-party';
    expect(projectClaudeNativeMessage(row, bridgePluginName, { ...submission, inputKind: 'media' }).pluginSource).toBe('third-party');
  });

  it('hides only a bound built-in submission, preserving original input and attachments', () => {
    const { row, submission } = fixture();
    const before = JSON.stringify(row);
    const display = projectClaudeNativeMessage(row, bridgePluginName, submission);
    expect(display).toEqual({ content: submission.originalContent });
    expect(display.content).toBe(submission.originalContent);
    expect(JSON.stringify(row)).toBe(before);
  });

  it('preserves other plugins even if their name or content looks like the built-in bridge', () => {
    for (const name of ['user-plugin', 'lex-native-bridge-extra', 'LEX-NATIVE-BRIDGE']) {
      const { row, submission } = fixture();
      row.origin.name = name;
      expect(projectClaudeNativeMessage(row, bridgePluginName, submission))
        .toEqual({ content: row.message.content, pluginSource: name });
    }
  });

  it('does not suppress an unbound same-name plugin or a row from another session/message', () => {
    const { row, submission } = fixture();
    for (const binding of [undefined, { ...submission, sessionId: 'another' },
      { ...submission, nativeMessageId: 'another' }, { ...submission, pluginName: 'another' },
      { ...submission, submissionId: '' }]) {
      expect(projectClaudeNativeMessage(row, bridgePluginName, binding))
        .toEqual({ content: row.message.content, pluginSource: bridgePluginName });
    }
  });

  it('never suppresses subagent, attachment, meta or non-user rows', () => {
    for (const override of [{ agentId: 'child' }, { door: 'attachment' },
      { message: { type: 'assistant', content: [] } },
      { message: { type: 'user', isMeta: true, content: [] } }]) {
      const { row, submission } = fixture();
      const other = { ...row, ...override };
      expect(projectClaudeNativeMessage(other, bridgePluginName, submission))
        .toEqual({ content: other.message.content, pluginSource: bridgePluginName });
    }
  });

  it('preserves native user input even when its text imitates a plugin envelope', () => {
    const { row, submission } = fixture();
    row.origin = { kind: 'composer' };
    expect(projectClaudeNativeMessage(row, bridgePluginName, submission)).toEqual({ content: row.message.content });
  });

  it('replays the same projection from saved native identity and host association without text deduplication', () => {
    const { row, submission } = fixture();
    const saved = JSON.parse(JSON.stringify({ row, submission }));
    expect(projectClaudeNativeMessage(saved.row, bridgePluginName, saved.submission))
      .toEqual({ content: submission.originalContent });
    const repeated = { ...row, uuid: 'second-identical-message' };
    expect(projectClaudeNativeMessage(repeated, bridgePluginName, submission).pluginSource).toBe(bridgePluginName);
    expect(projectClaudeNativeMessage(repeated, bridgePluginName, { ...submission,
      nativeMessageId: repeated.uuid, submissionId: 'second-send' })).toEqual({ content: submission.originalContent });
  });
});
