import { sharedTaskGuestPeer } from '@cindy/device-link';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAttachmentOssRef } from '@cindy/device-link';
import { assertSharedTaskInteractionResolveCurrent, assertSharedTaskInvoke, assertSharedTaskReferences, captureSharedTaskPush, claimSharedTaskInteraction, setSharedTaskInteractionReader, setSharedTaskQueueReader, sharedTaskScopedClientId, type SharedTaskInteractionCapture, type SharedTaskPeerCapture } from '../sharedTaskDispatch.js';

function capture(): SharedTaskPeerCapture {
  return {
    author: { sharedTaskId: 'sharedTask', sessionId: 'task', memberId: 'member', accountId: 'guest', deviceId: 'phone', displayName: 'Guest' },
    isCurrent: () => true,
    authorize: (operation, item) => operation !== 'input.edit' && operation !== 'input.withdraw' || item?.authorAccountId === 'guest',
  };
}
afterEach(() => { setSharedTaskQueueReader(null); setSharedTaskInteractionReader(null); });
describe('sharedTask dispatch scope', () => {
  it('reads subagent context only through the shared parent task', () => {
    for (const channel of ['local-db:subagent-runs:list', 'local-db:subagent-runs:detail', 'local-db:subagent-runs:transcript']) {
      const request = { sessionId: 'task', provider: 'pi', runIdOrAlias: 'child' };
      expect(() => assertSharedTaskInvoke(capture(), { channel, args: [request] })).not.toThrow();
      for (const args of [[{ ...request, sessionId: 'other' }], [{ ...request, path: '/private' }], [request, 'other']]) {
        expect(() => assertSharedTaskInvoke(capture(), { channel, args })).toThrow();
      }
      expect(() => assertSharedTaskInvoke({ ...capture(), isCurrent: () => false }, { channel, args: [request] })).toThrow();
    }
  });
  it('allows only existing references from the member own pending row when editing', () => {
    const payload = { channel: 'maker:input:update-content', args: ['task', 'message', { files: [{ path: '/host/cache/a.png' }] }] };
    setSharedTaskQueueReader((_sid, clientId) => clientId === 'message' ? { sessionId: 'task', authorAccountId: 'guest', state: 'pending', attachments: [{ path: '/host/cache/a.png' }] } : undefined);
    expect(() => assertSharedTaskInvoke(capture(), payload)).not.toThrow();
    expect(() => assertSharedTaskInvoke(capture(), { ...payload, args: ['task', 'other', payload.args[2]] })).toThrow();
    expect(() => assertSharedTaskInvoke(capture(), { ...payload, args: ['task', 'message', { files: [{ path: '/host/private.png' }] }] })).toThrow();
    setSharedTaskQueueReader(() => ({ sessionId: 'task', authorAccountId: 'owner', state: 'pending', attachments: [{ path: '/host/cache/a.png' }] }));
    expect(() => assertSharedTaskInvoke(capture(), payload)).toThrow();
  });
  it('never inherits the full-device allowlist or wildcard subscriptions', () => {
    for (const channel of ['maker:create-session', 'maker:set-permission-mode', 'device-link:voice:credential-sync', 'local-db:sessions:list', 'maker:remote-resources:list']) {
      expect(() => assertSharedTaskInvoke(capture(), { channel, args: ['task'] })).toThrow('PERMISSION_DENIED');
    }
    for (const topics of [['*'], ['sessions'], ['session:other'], ['session:task', 'session:other']]) {
      expect(() => assertSharedTaskInvoke(capture(), { channel: 'device-link:subscribe', args: [{ topics }] })).toThrow();
    }
    expect(() => assertSharedTaskInvoke(capture(), { channel: 'device-link:subscribe', args: [{ topics: ['session:task'] }] })).not.toThrow();
  });
  it('allows shared task history and Agent settings, rejecting another task', () => {
    for (const channel of ['local-db:messages:list', 'maker:set-model', 'maker:set-effort', 'maker:input:stop']) {
      expect(() => assertSharedTaskInvoke(capture(), { channel, args: ['task'] })).not.toThrow();
      expect(() => assertSharedTaskInvoke(capture(), { channel, args: ['other'] })).toThrow();
    }
  });
  it('allows guests to resolve generic Agent interaction cards for the shared task', () => {
    const permissionSuggestion = { type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'git status' }] };
    const interactions: Record<string, SharedTaskInteractionCapture> = {
      'permission-1': { sessionId: 'task', kind: 'permission', toolName: 'Bash', suggestions: [permissionSuggestion] },
      'question-1': { sessionId: 'task', kind: 'ask_user_question' },
      'plan-1': { sessionId: 'task', kind: 'plan_review' },
    };
    setSharedTaskInteractionReader((requestId) => interactions[requestId]);
    for (const [requestId, decision] of [
      ['permission-1', { kind: 'permission', behavior: 'allow' }],
      ['question-1', { kind: 'ask_user_question', answers: { choice: 'A' } }],
      ['plan-1', { kind: 'plan_review', behavior: 'deny', reason: 'change scope' }],
    ]) {
      expect(() => assertSharedTaskInvoke(capture(), {
        channel: 'maker:resolve-interaction', args: [requestId, decision],
      })).not.toThrow();
    }
    for (const decision of [
      { kind: 'plugin_setup', action: 'run_action' },
      { kind: 'issue_confirm', behavior: 'allow' },
      { kind: 'permission', behavior: 'maybe' },
    ]) {
      expect(() => assertSharedTaskInvoke(capture(), {
        channel: 'maker:resolve-interaction', args: ['permission-1', decision],
      })).toThrow('PERMISSION_DENIED');
    }
    expect(() => assertSharedTaskInvoke(capture(), {
      channel: 'maker:resolve-interaction', args: ['other-task', { kind: 'permission', behavior: 'allow' }],
    })).toThrow('PERMISSION_DENIED');
    expect(() => assertSharedTaskInvoke(capture(), {
      channel: 'maker:resolve-interaction',
      args: ['permission-1', { kind: 'permission', behavior: 'allow', permissionUpdates: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }] }],
    })).toThrow('PERMISSION_DENIED');
    expect(() => assertSharedTaskInvoke(capture(), {
      channel: 'maker:resolve-interaction',
      args: ['permission-1', { kind: 'permission', behavior: 'allow', permissionUpdates: [{ ...permissionSuggestion, rules: [{ toolName: 'Write' }] }] }],
    })).toThrow('PERMISSION_DENIED');
    expect(() => assertSharedTaskInvoke(capture(), {
      channel: 'maker:resolve-interaction',
      args: ['permission-1', { kind: 'permission', behavior: 'allow', permissionUpdates: [permissionSuggestion] }],
    })).not.toThrow();
  });
  it.each([{ command: 'different-command' }, {}, null])('rejects guest replacement input %j at admission and consumption', (updatedInput) => {
    setSharedTaskInteractionReader(() => ({ sessionId: 'task', kind: 'permission', toolName: 'Bash' }));
    const args = ['permission-1', { kind: 'permission', behavior: 'allow', updatedInput }];
    expect(() => assertSharedTaskInvoke(capture(), { channel: 'maker:resolve-interaction', args })).toThrow('PERMISSION_DENIED');
    expect(() => assertSharedTaskInteractionResolveCurrent(capture(), args)).toThrow('PERMISSION_DENIED');
  });
  it('accepts the host-provided Codex session approval, but rejects an unsolicited one', () => {
    const update = { type: 'codexSessionApproval', destination: 'session' };
    const request: SharedTaskInteractionCapture = { sessionId: 'task', kind: 'permission', toolName: 'Shell', suggestions: [update] };
    setSharedTaskInteractionReader(() => request);
    const args = ['permission-1', { kind: 'permission', behavior: 'allow', permissionUpdates: [update] }];
    expect(() => assertSharedTaskInvoke(capture(), { channel: 'maker:resolve-interaction', args })).not.toThrow();
    expect(() => assertSharedTaskInteractionResolveCurrent(capture(), args)).not.toThrow();
    request.suggestions = [];
    expect(() => assertSharedTaskInvoke(capture(), { channel: 'maker:resolve-interaction', args })).toThrow('PERMISSION_DENIED');
    expect(() => assertSharedTaskInteractionResolveCurrent(capture(), args)).toThrow('PERMISSION_DENIED');
  });
  it.each([
    { type: 'codexSessionApproval', destination: 'userSettings' },
    { type: 'codexSessionApproval', destination: 'session', mode: 'bypassPermissions' },
    { type: 'codexSessionApproval', destination: 'session', rules: [{ toolName: 'Write' }] },
    { type: 'setMode', destination: 'session', mode: 'bypassPermissions' },
  ])('rejects unsafe session approval shapes even when suggested: %j', (update) => {
    setSharedTaskInteractionReader(() => ({ sessionId: 'task', kind: 'permission', toolName: 'Shell', suggestions: [update] }));
    const args = ['permission-1', { kind: 'permission', behavior: 'allow', permissionUpdates: [update] }];
    expect(() => assertSharedTaskInvoke(capture(), { channel: 'maker:resolve-interaction', args })).toThrow('PERMISSION_DENIED');
    expect(() => assertSharedTaskInteractionResolveCurrent(capture(), args)).toThrow('PERMISSION_DENIED');
  });
  it('rejects a request that disappeared before consumption', () => {
    let active = true;
    setSharedTaskInteractionReader(() => active
      ? { sessionId: 'task', kind: 'permission', toolName: 'Bash' }
      : undefined);
    const args: unknown[] = ['request-1', { kind: 'permission', behavior: 'allow' }];
    expect(() => assertSharedTaskInvoke(capture(), { channel: 'maker:resolve-interaction', args })).not.toThrow();
    active = false;
    expect(() => assertSharedTaskInteractionResolveCurrent(capture(), args)).toThrow('PERMISSION_DENIED');
  });
  it('claims one pending interaction under a two-guest race and rechecks revoke before consume', async () => {
    const pending = new Map([['request-race', { sessionId: 'task', kind: 'permission' as const }]]);
    const args: unknown[] = ['request-race', { kind: 'permission', behavior: 'allow' }];
    let active = true;
    const peer: SharedTaskPeerCapture = { ...capture(), isCurrent: () => active, authorize: () => active };
    setSharedTaskInteractionReader(() => pending.get('request-race'));
    const gate = Promise.resolve();
    const consume = async (): Promise<boolean> => {
      assertSharedTaskInteractionResolveCurrent(peer, args);
      await gate;
      // Production registerMakerIpc performs this same synchronous claim after
      // the final capture check; a late revoke cannot turn a stale admission
      // into a successful resolver call.
      try {
        assertSharedTaskInteractionResolveCurrent(peer, args);
      } catch {
        return false;
      }
      return claimSharedTaskInteraction(pending, 'request-race') !== null;
    };
    const raced = await Promise.all([consume(), consume()]);
    expect(raced.sort()).toEqual([false, true]);
    expect(pending.size).toBe(0);

    pending.set('request-race', { sessionId: 'task', kind: 'permission' });
    active = true;
    assertSharedTaskInteractionResolveCurrent(peer, args);
    active = false;
    expect(() => assertSharedTaskInteractionResolveCurrent(peer, args)).toThrow('PERMISSION_DENIED');
    expect(claimSharedTaskInteraction(pending, 'request-race')).not.toBeNull();
  });
  it.each(['permission', 'ask_user_question', 'plan_review'] as const)('rejects a revoked guest with a still-pending %s request', (kind) => {
    const pending = { sessionId: 'task', kind, toolName: 'Bash' };
    setSharedTaskInteractionReader(() => pending);
    let memberActive = true;
    const peer = { ...capture(), isCurrent: () => memberActive, authorize: () => memberActive };
    const decision = kind === 'ask_user_question'
      ? { kind, answers: { choice: 'A' } } : { kind, behavior: 'allow' };
    const args = ['request-1', decision];
    assertSharedTaskInvoke(peer, { channel: 'maker:resolve-interaction', args });
    memberActive = false;
    expect(() => assertSharedTaskInteractionResolveCurrent(peer, args)).toThrow('PERMISSION_DENIED');
    expect(() => assertSharedTaskInteractionResolveCurrent(capture(), args)).not.toThrow();
  });
  it('lets a guest read running command output only for the shared task, under history.read', () => {
    const channel = 'maker:background-task:output-tail';
    expect(() => assertSharedTaskInvoke(capture(), { channel, args: ['task', 'bash-1'] })).not.toThrow();
    expect(() => assertSharedTaskInvoke(capture(), { channel, args: ['other', 'bash-1'] })).toThrow();
    const noHistory: SharedTaskPeerCapture = { ...capture(), authorize: (operation) => operation !== 'history.read' };
    expect(() => assertSharedTaskInvoke(noHistory, { channel, args: ['task', 'bash-1'] })).toThrow();
  });
  it('accepts media preparation and OSS fallback without granting the file-peer channel', () => {
    for (const prepareOnly of [true, false]) {
      expect(() => assertSharedTaskInvoke(capture(), {
        channel: 'device-link:media:fetch', args: [{ url: 'xdt-image://task/a.png', prepareOnly }],
      })).not.toThrow();
    }
    expect(() => assertSharedTaskInvoke(capture(), {
      channel: 'device-link:media:fetch', args: [{ url: 'xdt-image://task/a.png', prepareOnly: true, sessionId: 'other' }],
    })).toThrow();
    expect(() => assertSharedTaskInvoke(capture(), {
      channel: 'device-link:file-peer', args: [{ action: 'caps' }],
    })).toThrow();
  });
  it('checks nested references in both structured and persisted content before hydration', () => {
    for (const value of [
      { agentReferences: [{ kind: 'message', sessionId: 'other' }] },
      { persistedContent: JSON.stringify({ agentReferences: [{ kind: 'message', sessionId: 'other' }] }) },
      { trustedSessionReferenceContexts: [{ sessionId: 'other' }] },
      { agentReferences: [{ kind: 'bot', botId: 'private-bot' }] },
      { files: [{ path: 'private/other-task.png', pathOrigin: 'desktop-host' }] },
      { persistedContent: JSON.stringify({ images: [{ url: 'cindy-media://blobs/private.png' }] }) },
    ]) expect(() => assertSharedTaskReferences(value, 'task')).toThrow();
    expect(() => assertSharedTaskReferences({ agentReferences: [{ kind: 'message', sessionId: 'task' }] }, 'task')).not.toThrow();
  });
  it('admits only current-task OSS references for authenticated server download, without claiming device provenance', () => {
    const ref = buildAttachmentOssRef({
      ossKey: 'cindy/device-link/shared-task/sharedTask/opaque/file',
      size: 1,
      sha256: 'a'.repeat(64),
      mimeType: 'image/png',
    });
    setSharedTaskQueueReader(() => ({ sessionId: 'task', authorAccountId: 'guest', state: 'pending' }));
    const payload = {
      channel: 'maker:input:update-content',
      args: ['task', 'message', { files: [{ url: ref }] }],
    };
    expect(() => assertSharedTaskInvoke({ ...capture(), authorize: () => true }, payload)).not.toThrow();
    expect(() => assertSharedTaskInvoke({ ...capture(), isCurrent: () => false }, payload)).toThrow();
    expect(() => assertSharedTaskInvoke({ ...capture(), authorize: () => false }, payload)).toThrow();
    const other = buildAttachmentOssRef({ ossKey: 'cindy/device-link/shared-task/other/opaque/file' });
    expect(() => assertSharedTaskInvoke({ ...capture(), authorize: () => true }, { ...payload, args: ['task', 'message', { files: [{ url: other }] }] })).toThrow();
    const verify = (value: string, binding: { sharedTaskId: string; sessionId: string; memberId: string; accountId: string; deviceId: string }) =>
      value === ref && binding.sharedTaskId === 'sharedTask' && binding.sessionId === 'task' &&
      binding.memberId === 'member' && binding.accountId === 'guest' && binding.deviceId === 'phone';
    expect(() => assertSharedTaskInvoke({ ...capture(), authorize: () => true, verifyAttachment: verify }, payload)).not.toThrow();
  });
  it('scopes same controller clientId by shared task member', () => {
    const first = capture();
    const second = { ...capture(), author: { ...capture().author, memberId: 'other-member' } };
    expect(sharedTaskScopedClientId(first, 'same-client')).not.toBe(sharedTaskScopedClientId(second, 'same-client'));
    expect(sharedTaskScopedClientId(first, 'same-client')).toBe(sharedTaskScopedClientId(first, 'same-client'));
  });
  it('reads queue ownership from the host and allows results after successful withdrawal', () => {
    const payload = { channel: 'maker:input:remove', args: ['task', 'message'] };
    expect(() => assertSharedTaskInvoke(capture(), payload)).toThrow();
    setSharedTaskQueueReader(() => ({ sessionId: 'task', authorAccountId: 'owner', state: 'pending' }));
    expect(() => assertSharedTaskInvoke(capture(), payload)).toThrow();
    setSharedTaskQueueReader(() => ({ sessionId: 'task', authorAccountId: 'guest', state: 'pending' }));
    expect(() => assertSharedTaskInvoke(capture(), payload)).not.toThrow();
    setSharedTaskQueueReader(() => undefined);
    expect(() => assertSharedTaskInvoke(capture(), payload, undefined, 'result')).not.toThrow();
  });
  it('rejects expired captured authorization and unbound sharedTask pushes without changing same-account traffic', () => {
    expect(() => assertSharedTaskInvoke({ ...capture(), isCurrent: () => false }, { channel: 'local-db:messages:list', args: ['task'] })).toThrow();
    expect(captureSharedTaskPush(sharedTaskGuestPeer('m', 'g', 'd'), 'maker:event', { sessionId: 'task' })).toBeNull();
    expect(captureSharedTaskPush('my-phone', 'maker:provider:changed', {})?.()).toBe(true);
  });
});
