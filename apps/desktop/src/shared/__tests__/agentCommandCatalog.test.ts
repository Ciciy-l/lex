import { describe, expect, it } from 'vitest';

import {
  createAgentCommandCatalogChangedPayload,
  parseAgentCommandCatalogChangedPayload,
} from '../agentCommandCatalog';

describe('agent command catalog push payload', () => {
  it('accepts and freezes an OMP session invalidation', () => {
    const payload = parseAgentCommandCatalogChangedPayload({
      sessionId: 'session-1',
      agentKind: 'omp',
      revision: 3,
      status: 'loaded',
    });

    expect(payload).toEqual({
      sessionId: 'session-1',
      agentKind: 'omp',
      revision: 3,
      status: 'loaded',
    });
    expect(Object.isFrozen(payload)).toBe(true);
    expect(createAgentCommandCatalogChangedPayload(payload!)).toEqual(payload);
  });

  it.each([
    {},
    { sessionId: '', agentKind: 'omp', revision: 0, status: 'unknown' },
    { sessionId: 's', agentKind: 'unknown', revision: 0, status: 'unknown' },
    { sessionId: 's', agentKind: 'omp', revision: -1, status: 'unknown' },
    { sessionId: 's', agentKind: 'omp', revision: 0.5, status: 'unknown' },
    { sessionId: 's', agentKind: 'omp', revision: 0, status: 'stale' },
  ])('rejects an invalid payload: %j', (value) => {
    expect(parseAgentCommandCatalogChangedPayload(value)).toBeNull();
  });
});
