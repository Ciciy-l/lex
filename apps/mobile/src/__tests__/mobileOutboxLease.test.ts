import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { isDurableOutboxHandedOff, isDurableOutboxSettled, type DurableOutboxRecord } from '@/session/durableOutbox';
import { buildOutboxItem } from '@/session/sessionOutbox';

// Execute the actual bridge callbacks without importing its native UI dependencies.
const source = ts.createSourceFile('MobileOutboxBridge.tsx', readFileSync(
  new URL('../session/MobileOutboxBridge.tsx', import.meta.url), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = new Map<string, string>();
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.initializer
    && ['needsReconciliation', 'refreshLeases', 'leaseKey'].includes(node.name.getText(source))) {
    callbacks.set(node.name.getText(source), node.initializer.getText(source));
  }
  ts.forEachChild(node, visit);
}
visit(source);
for (const name of ['needsReconciliation', 'refreshLeases', 'leaseKey']) {
  if (!callbacks.has(name)) throw new Error(`Missing bridge callback: ${name}`);
}
function record(sessionId: string, patch: Partial<DurableOutboxRecord> = {}): DurableOutboxRecord {
  return { version: 1, accountId: 'global:owner', deviceId: 'desktop', createdAt: 1, state: 'queued', uploads: [],
    item: buildOutboxItem({ sessionId, clientId: `send-${sessionId}`, text: 'hello',
      permissionModeAtSend: 'ask', readyAttachments: [], readyPreviews: [], claimedUploads: [] }), ...patch };
}
function harness(initial: DurableOutboxRecord[]) {
  let records = initial;
  let current = true;
  const visible = new Set<string>();
  const leases = new Map<string, { release: ReturnType<typeof vi.fn> }>();
  const acquire = vi.fn(() => ({ release: vi.fn() }));
  const bindings = {
    isCurrent: () => current, mobileDurableOutbox: { getSnapshot: () => records }, leases,
    isDurableOutboxHandedOff, isDurableOutboxSettled,
    remoteSessionStore: { acquireSessionMessageWork: acquire },
    findRemoteHistoryView: (_device: string, session: string) => ({ isActive: () => visible.has(session) }),
  };
  const js = ts.transpileModule(`const { ${Object.keys(bindings).join(', ')} } = bindings;
    const leaseKey = ${callbacks.get('leaseKey')};
    const needsReconciliation = ${callbacks.get('needsReconciliation')};
    return ${callbacks.get('refreshLeases')};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const refresh = new Function('bindings', js)(bindings) as () => void;
  return { leases, visible, acquire, refresh,
    setRecords: (next: DurableOutboxRecord[]) => { records = next; },
    revoke: () => { current = false; },
  };
}

describe('outbox history window ownership', () => {
  it.each([true, false])('releases hidden accepted windows and resumes on reentry (durable=%s)', durable => {
    const accepted = record('accepted', { state: 'host-owned', retrySafe: durable, historyConfirmed: !durable });
    const sending = record('sending');
    const bridge = harness([accepted, sending]);
    bridge.refresh();
    expect(bridge.acquire.mock.calls).toEqual([['sending', true]]);
    bridge.visible.add('accepted');
    bridge.refresh();
    expect(bridge.leases.size).toBe(2);
    const acceptedLease = bridge.leases.get(JSON.stringify(['desktop', 'accepted']))!;
    const sendingLease = bridge.leases.get(JSON.stringify(['desktop', 'sending']))!;
    bridge.visible.clear();
    bridge.refresh();
    expect(acceptedLease.release).toHaveBeenCalledOnce();
    expect(sendingLease.release).not.toHaveBeenCalled();
    bridge.setRecords([{ ...accepted, cancelRequested: true }, sending]);
    bridge.refresh();
    expect(bridge.leases.size).toBe(2);
    expect(bridge.acquire).toHaveBeenLastCalledWith('accepted', true);
    bridge.setRecords([{ ...accepted, cleanupOutcome: 'accepted' }, sending]);
    bridge.refresh();
    expect(bridge.leases.size).toBe(1);
    expect(sendingLease.release).not.toHaveBeenCalled();
  });
  it('does not acquire windows from a revoked account generation', () => {
    const bridge = harness([record('pending')]);
    bridge.revoke();
    bridge.refresh();
    expect(bridge.acquire).not.toHaveBeenCalled();
  });
});
