import { describe, expect, it } from 'vitest';
import { ORCA_NATIVE_BODY, type OrcaNativeBodySource } from '@cindy/maker-core';
import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';
import { stampTrustedDesktopQueuedOrigin } from '../makerSendTransaction.js';
import { readOrcaNativeBody, restoreOrcaNativeBody, stampOrcaNativeBody } from '../orcaNativeInput.js';

const source: OrcaNativeBodySource = { version: 1, targetSessionId: 'worker-task', clientId: 'message-1',
  role: 'worker', teamId: 'team', workerId: 'worker', leadSessionId: 'lead' };
const item = { clientId: 'message-1', text: 'same', persistedContent: 'same',
  origin: { kind: 'orca', senderLabel: 'Lead', displayText: 'same' }, autoResume: true,
} as AgentInputQueuedMessage;

describe('Host-only Orca queue provenance', () => {
  it('does not infer authorization from origin, autoResume, or serialized fields at ordinary ingress', () => {
    expect(readOrcaNativeBody(item)).toBeUndefined();
    const stamped = stampOrcaNativeBody(item, source);
    for (const deviceLink of [false, true]) {
      const incoming = stampTrustedDesktopQueuedOrigin(stamped, deviceLink, true);
      expect(readOrcaNativeBody(incoming)).toBeUndefined();
      expect(readOrcaNativeBody(restoreOrcaNativeBody('worker-task', incoming))).toBeUndefined();
    }
  });
  it('restores only the exact owner-scoped target and client, never arbitrary origin metadata', () => {
    const stored = JSON.parse(JSON.stringify(stampOrcaNativeBody(item, source)));
    expect(readOrcaNativeBody(stored)).toBeUndefined();
    expect(readOrcaNativeBody(restoreOrcaNativeBody('worker-task', stored))).toEqual(source);
    expect(readOrcaNativeBody(restoreOrcaNativeBody('other-task', stored))).toBeUndefined();
    expect(readOrcaNativeBody(restoreOrcaNativeBody('worker-task', { ...stored, clientId: 'message-2' }))).toBeUndefined();
    expect(readOrcaNativeBody(restoreOrcaNativeBody('worker-task', item))).toBeUndefined();
  });
  it('keeps two equal texts distinct and does not permit mutating the live authority receipt', () => {
    const first = stampOrcaNativeBody(item, source) as AgentInputQueuedMessage & { [ORCA_NATIVE_BODY]: OrcaNativeBodySource };
    const second = stampOrcaNativeBody({ ...item, clientId: 'message-2' }, { ...source, clientId: 'message-2' });
    expect(readOrcaNativeBody(second)?.clientId).not.toBe(first[ORCA_NATIVE_BODY].clientId);
    expect(Object.isFrozen(first[ORCA_NATIVE_BODY])).toBe(true);
  });
});
