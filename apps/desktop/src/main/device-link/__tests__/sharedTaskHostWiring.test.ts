import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { parseSharedTaskPeer, probeSharedTaskHost, sharedTaskGuestPeer, sharedTaskHostPeer } from '@cindy/device-link';

// Execute the actual singleton callbacks without booting Electron or reading
// a user's profile. The socket/SQLite dispatch path has separate integration tests.
const source = ts.createSourceFile('index.ts', readFileSync(resolve(process.cwd(), 'src/main/device-link/index.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
function evaluate(text: string, context: Record<string, unknown>) {
  const compiled = ts.transpileModule('const callback = ' + text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(context), compiled + '; return callback;')(...Object.values(context));
}
function property(name: string): ts.PropertyAssignment {
  let found: ts.PropertyAssignment | undefined;
  function visit(node: ts.Node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === name) found = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!found) throw new Error('Missing production property ' + name);
  return found;
}

describe('SharedTask production host wiring', () => {
  it('revokes only the selected task member, leaving another guest/task and the ordinary owner connected', () => {
    const declaration = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'startSharedTaskRuntimeForCurrentClient');
    if (!declaration?.body) throw new Error('Missing production runtime wiring');
    let callbacks!: { revoke(task: string, member?: string): void; changed(task: string): void };
    const affected = sharedTaskGuestPeer('task-a', 'member-a', 'phone');
    const otherMember = sharedTaskGuestPeer('task-a', 'member-b', 'phone');
    const otherTask = sharedTaskGuestPeer('task-b', 'member-a', 'phone');
    const closeLink = vi.fn();
    const purge = vi.fn();
    const forget = vi.fn();
    const broadcast = vi.fn();
    let ownerScope = 'owner-a';
    const run = evaluate('function() ' + declaration.body.getText(source), {
      client: { closeLink }, parseSharedTaskPeer,
      startSharedTaskRuntime: (value: typeof callbacks) => { callbacks = value; },
      getKnownControllerIds: () => [affected, otherMember, otherTask, 'owner-physical'],
      purgeRevokedController: purge, forgetControllerInvokeState: forget, broadcast,
      isAppSessionBoundaryPending: () => false,
      authManager: { getCurrentUserId: () => ownerScope, getActiveAuthRealm: () => 'global' },
    });
    run();
    callbacks.revoke('task-a', 'member-a');
    expect(closeLink.mock.calls).toEqual([[affected, 'revoked', 'inbound']]);
    expect(purge.mock.calls).toEqual([[affected]]);
    expect(forget.mock.calls).toEqual([[affected]]);
    callbacks.changed('task-a');
    expect(broadcast).toHaveBeenCalledWith('shared-task:changed', { sharedTaskId: 'task-a' });
    closeLink.mockClear();
    callbacks.revoke('task-a');
    expect(closeLink.mock.calls).toEqual([[affected, 'revoked', 'inbound'], [otherMember, 'revoked', 'inbound']]);
    ownerScope = 'owner-b';
    closeLink.mockClear(); broadcast.mockClear();
    callbacks.revoke('task-a'); callbacks.changed('task-a');
    expect(closeLink).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('probes only the authenticated shared session and keeps the ordinary device probe', async () => {
    const invoke = vi.fn(async () => ({ ok: true, result: null }));
    const client = { invoke, getConnectionEpoch: () => 7, isLinkReady: () => true };
    const peer = sharedTaskHostPeer('task-a', 'desktop');
    const get = vi.fn(async () => ({ sharedTaskId: 'task-a', sessionId: 'session-a', status: 'active' }));
    const callback = evaluate(property('probeInvoke').initializer.getText(source), {
      client, parseSharedTaskPeer, probeSharedTaskHost,
      activeOwnerScopeKey: () => 'owner', arbiter: { isOwner: () => true },
      isAppSessionBoundaryPending: () => false, revokedByRemote: new Set(),
      sharedTaskApi: { get }, openRemoteLink: vi.fn(), INVOKE_TIMEOUT_OVERRIDES_MS: {},
    });
    await callback(peer, 'local-db:sessions:list', []);
    expect(get).toHaveBeenCalledWith('task-a');
    expect(invoke.mock.calls).toEqual([[peer, { channel: 'local-db:sessions:get', args: ['session-a'] }]]);
    await callback('ordinary', 'local-db:sessions:list', []);
    expect(invoke).toHaveBeenLastCalledWith('ordinary', { channel: 'local-db:sessions:list', args: [] }, undefined);
  });

  it('does not invoke a guest probe after its connection generation changes during authority lookup', async () => {
    let epoch = 7;
    const invoke = vi.fn();
    const client = { invoke, getConnectionEpoch: () => epoch, isLinkReady: () => true };
    const callback = evaluate(property('probeInvoke').initializer.getText(source), {
      client, parseSharedTaskPeer, probeSharedTaskHost,
      activeOwnerScopeKey: () => 'owner', arbiter: { isOwner: () => true },
      isAppSessionBoundaryPending: () => false, revokedByRemote: new Set(),
      sharedTaskApi: { get: async () => { epoch++; return { sharedTaskId: 'task-a', sessionId: 'session-a', status: 'active' }; } },
      openRemoteLink: vi.fn(), INVOKE_TIMEOUT_OVERRIDES_MS: {},
    });
    await expect(callback(sharedTaskHostPeer('task-a', 'desktop'), 'local-db:sessions:list', [])).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('declares the incremental capability without enabling ordinary remote control', () => {
    const hello = evaluate(property('getHello').initializer.getText(source), {
      SHARED_TASK_CAPABILITY: 'shared-task-v2', deviceName: () => 'fixture',
      process: { platform: 'win32' }, app: { getVersion: () => 'fixture' },
      readDeviceLinkSettings: () => ({ remoteControlEnabled: false }),
      buildDeviceInfo: () => ({}), helloBusy: () => false,
    });
    expect(hello()).toMatchObject({ capabilities: ['shared-task-v2'], remoteControlEnabled: false });
  });
});
