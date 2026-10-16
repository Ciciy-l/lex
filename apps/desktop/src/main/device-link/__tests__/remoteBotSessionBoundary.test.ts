import { afterEach, expect, it, vi } from 'vitest';
import {
  assertRemoteBotInvocationAllowed,
  projectRemoteBotPush, projectRemoteSessionResult, setRemoteBotSessionLookup } from '../remoteBotSessionBoundary';

afterEach(() => setRemoteBotSessionLookup(null));

it.each(['local-db:sessions:get-many', 'local-db:orca-workflows:list-workers-by-leads'])(
  'checks every positional task ID before a batch invocation: %s', async channel => {
    const lookup = vi.fn(async (id: string) => id === 'retained' ? 'hidden' as const : 'ordinary' as const);
    setRemoteBotSessionLookup(lookup);
    await expect(assertRemoteBotInvocationAllowed([['normal', 'retained']], channel)).rejects.toThrow('NOT_FOUND');
    await expect(assertRemoteBotInvocationAllowed([['normal']], channel)).resolves.toBeUndefined();
    expect(lookup).toHaveBeenCalledWith('retained', 'session');
  },
);

it('does not interpret catalog kinds, plugin paths or schedule IDs as task IDs before DB startup', async () => {
  for (const [channel, args] of [
    ['maker:get-capabilities', ['pi']],
    ['maker:agent:binary-version', ['claude-code']],
    ['maker:plugins:list', ['/workspace', true]],
    ['maker:schedule:get', ['scheduled-job']],
    ['maker:provider:list', [{ capabilities: ['chat'] }]],
  ] as const) {
    await expect(assertRemoteBotInvocationAllowed([...args], channel)).resolves.toBeUndefined();
  }
  for (const channel of ['maker:send', 'maker:set-model', 'local-db:messages:list', 'local-db:sessions:get']) {
    await expect(assertRemoteBotInvocationAllowed(['retained'], channel)).rejects.toThrow('[NOT_FOUND]');
  }
});

it('checks structured source and target task IDs while allowing a genuinely new task', async () => {
  setRemoteBotSessionLookup(async id => id === 'retained' ? 'hidden' : 'missing');
  await expect(assertRemoteBotInvocationAllowed([{ sessionId: 'new-task' }], 'maker:create-session')).resolves.toBeUndefined();
  for (const arg of [{ parentSessionId: 'retained' }, { targetSessionId: 'retained' }, { sourceSessionId: 'retained' }]) {
    await expect(assertRemoteBotInvocationAllowed([arg], 'maker:create-session')).rejects.toThrow('[NOT_FOUND]');
  }
});

it('checks the normalized source task before remote Review and rechecks visibility changes', async () => {
  let hidden = false;
  const lookup = vi.fn(async () => hidden ? 'hidden' as const : 'ordinary' as const);
  setRemoteBotSessionLookup(lookup);
  const args = [{ sourceSessionId: ' source ' }];
  await assertRemoteBotInvocationAllowed(args, 'maker:review:start');
  expect(lookup).toHaveBeenCalledWith('source', 'session');
  hidden = true;
  await expect(assertRemoteBotInvocationAllowed(args, 'maker:review:start')).rejects.toThrow('[NOT_FOUND]');
});

it.each([undefined, '', '   ', 123, 'x'.repeat(513)])('rejects invalid Review source ID %s', async (sourceSessionId) => {
  await expect(assertRemoteBotInvocationAllowed([{ sourceSessionId }], 'maker:review:start')).rejects.toThrow('[INVALID_PARAMS]');
});

it.each(['turn-list', 'turn-get'])('rechecks nested %s targets before returning remote snapshots', async (op) => {
  let hidden = false;
  setRemoteBotSessionLookup(async () => hidden ? 'hidden' : 'visible');
  const args = [{ op, payload: { sessionId: 'task', ids: ['set'] } }];
  await assertRemoteBotInvocationAllowed(args, 'git-review:remote-op');
  hidden = true;
  await expect(assertRemoteBotInvocationAllowed(args, 'git-review:remote-op')).rejects.toThrow('[NOT_FOUND]');
});

it('bounds single-lookup adapters, deduplicates checks and preserves collection order', async () => {
  let active = 0;
  let peak = 0;
  const lookup = vi.fn(async (id: string) => {
    peak = Math.max(peak, ++active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active--;
    return id === 'hidden' ? 'hidden' as const : 'ordinary' as const;
  });
  setRemoteBotSessionLookup(lookup);
  const rows = Array.from({ length: 1000 }, (_, i) => ({ id: `${i}` }));
  expect(await projectRemoteSessionResult('local-db:sessions:list', { sessions: [null, ...rows, { id: 'hidden' }, rows[0]], count: 1002 }))
    .toEqual({ sessions: [...rows, rows[0]], count: 1002 });
  expect(lookup).toHaveBeenCalledTimes(1001);
  expect(peak).toBe(1);
});

it('strips all retired resource identities while preserving portable resources and revisions', async () => {
  const single = vi.fn(async () => 'visible' as const);
  const batch = vi.fn(async () => new Map<string, 'visible'>());
  setRemoteBotSessionLookup(single, batch);
  const other = { ref: { id: 'other', kind: 'document' }, revision: 'a' };
  const result = await projectRemoteSessionResult('maker:remote-resources:list', {
    items: [other, { ref: { id: 'old', kind: 'bot' }, revision: 'b' },
      { ref: { id: 'group', kind: 'group', collectionId: 'bot-groups' } }], revision: 'old',
  });
  expect(result).toEqual({ items: [other], revision: 'a' });
  expect(single).not.toHaveBeenCalled();
  expect(batch).not.toHaveBeenCalled();
});

it('fails closed for incomplete batch results, rejects hidden gets and clears a replaced batch adapter', async () => {
  const batch = vi.fn(async () => new Map());
  setRemoteBotSessionLookup(async () => 'hidden', batch);
  expect(await projectRemoteSessionResult('maker:list-active', [{ sessionId: 's1' }])).toEqual([]);
  await expect(projectRemoteSessionResult('local-db:sessions:get', { id: 's1' })).rejects.toThrow('[NOT_FOUND]');
  expect(batch).toHaveBeenCalledTimes(2);
  setRemoteBotSessionLookup(async () => 'ordinary');
  expect(await projectRemoteSessionResult('maker:list-active', [{ sessionId: 's1' }])).toEqual([{ sessionId: 's1' }]);
  expect(batch).toHaveBeenCalledTimes(2);
});

it.each(['kind', 'resourceKind'])('rejects legacy bot-group %s even outside the original collection', async (field) => {
  const ref = { id: 'legacy-group', collectionId: 'custom-collection', [field]: 'bot-group' };
  await expect(assertRemoteBotInvocationAllowed([{ ref }], 'maker:remote-resources:get')).rejects.toThrow('[NOT_FOUND]');
  await expect(projectRemoteSessionResult('maker:remote-resources:get', { ref })).rejects.toThrow('[NOT_FOUND]');
  expect(await projectRemoteSessionResult('maker:remote-resources:list', { items: [{ ref }] })).toEqual({ items: [], revision: '' });
  expect(await projectRemoteBotPush({ ref }, 'maker:remote-resources:changed')).toBeNull();
  const ordinary = { ref: { ...ref, [field]: 'document' } };
  await expect(assertRemoteBotInvocationAllowed([ordinary], 'maker:remote-resources:get')).resolves.toBeUndefined();
  expect(await projectRemoteSessionResult('maker:remote-resources:get', ordinary)).toEqual(ordinary);
});

it('filters hidden runtime rows inside a complete active-session snapshot', async () => {
  setRemoteBotSessionLookup(async (id) => id === 'hidden' ? 'hidden' : 'ordinary');
  expect(await projectRemoteSessionResult('maker:list-active', {
    format: 'active-sessions-v2', sessions: [
      { sessionId: 'visible' }, { sessionId: 'hidden' },
    ],
  })).toEqual({ format: 'active-sessions-v2', sessions: [{ sessionId: 'visible' }] });
});


it('filters batch detail reads using the shared fresh visibility lookup', async () => {
  let hidden = false;
  const batch = vi.fn(async () => new Map([['s', hidden ? 'hidden' as const : 'visible' as const]]));
  setRemoteBotSessionLookup(async () => 'visible', batch);
  expect(await projectRemoteSessionResult('local-db:sessions:get-many', [{ id: 's' }])).toEqual([{ id: 's' }]);
  hidden = true;
  expect(await projectRemoteSessionResult('local-db:sessions:get-many', [{ id: 's' }])).toEqual([]);
  expect(batch).toHaveBeenCalledTimes(2);
});

it('checks every target of a label batch and filters only task rows in label results', async () => {
  setRemoteBotSessionLookup(async (id) => (id === 'hidden' ? 'hidden' : 'ordinary'));
  await expect(
    assertRemoteBotInvocationAllowed(
      [{ action: 'attach', sessionIds: ['ordinary', 'hidden'], tagIds: ['label'] }],
      'local-db:task-tags:execute',
    ),
  ).rejects.toThrow('[NOT_FOUND]');
  const tags = [{ id: 'hidden', name: 'A label ID is not a task ID' }];
  expect(
    await projectRemoteSessionResult('local-db:task-tags:execute', {
      tags,
      sessions: [
        { sessionId: 'ordinary', tags: [] },
        { sessionId: 'hidden', tags: [] },
      ],
    }),
  ).toEqual({ tags, sessions: [{ sessionId: 'ordinary', tags: [] }] });
});

it.each(['get', 'attach', 'detach'])('checks normalized task IDs for tag %s', async (action) => {
  setRemoteBotSessionLookup(async (id) => (id === 'hidden' ? 'hidden' : 'missing'));
  await expect(
    assertRemoteBotInvocationAllowed(
      [{ action, sessionIds: [' hidden '], tagIds: ['label'] }],
      'local-db:task-tags:execute',
    ),
  ).rejects.toThrow('[NOT_FOUND]');
});

it.each([
  undefined, [], [''], ['   '], [123], ['x'.repeat(129)],
  Array.from({ length: 101 }, () => 'same'),
  Array.from({ length: 10000 }, (_, i) => `session-${i}`),
])('rejects malformed tag targets before any authorization lookup (%#)', async (sessionIds) => {
  const lookup = vi.fn(async () => 'ordinary' as const);
  setRemoteBotSessionLookup(lookup);
  await expect(assertRemoteBotInvocationAllowed(
    [{ action: 'get', sessionIds }], 'local-db:task-tags:execute',
  )).rejects.toThrow('[INVALID_PARAMS]');
  expect(lookup).not.toHaveBeenCalled();
});

it('bounds normalized tag authorization and ignores unrelated object references', async () => {
  const lookup = vi.fn(async () => 'ordinary' as const);
  setRemoteBotSessionLookup(lookup);
  const sessionIds = Array.from({ length: 100 }, (_, i) => ` ${String(i).padStart(128, 'x')} `);
  await assertRemoteBotInvocationAllowed(
    [{ action: 'get', sessionIds, sessionId: 'unused', session: { id: 'unused' } }],
    'local-db:task-tags:execute',
  );
  expect(lookup).toHaveBeenCalledTimes(100);
  expect(lookup).toHaveBeenNthCalledWith(1, sessionIds[0].trim(), 'session');
  lookup.mockClear();
  await assertRemoteBotInvocationAllowed(
    [{ action: 'attach', sessionIds: [' task ', 'task'], tagIds: ['label'] }],
    'local-db:task-tags:execute',
  );
  expect(lookup).toHaveBeenCalledTimes(1);
});

it('rejects retired channels and resource references before DB startup', async () => {
  for (const channel of ['local-db:bots:get', 'maker:bot-direct-message-thread:get', 'routines:save']) {
    await expect(assertRemoteBotInvocationAllowed(['old'], channel)).rejects.toThrow('[NOT_FOUND]');
  }
  for (const ref of [
    { collectionId: 'teammates', kind: 'bot', id: 'old' },
    { collectionId: 'bot-groups', kind: 'group', id: 'old' },
    { collectionId: 'routines', kind: 'routine', id: 'old' },
  ]) {
    await expect(assertRemoteBotInvocationAllowed([{ ref }], 'maker:remote-resources:get')).rejects.toThrow('[NOT_FOUND]');
  }
  await expect(assertRemoteBotInvocationAllowed(['session'], 'maker:send')).rejects.toThrow('[NOT_FOUND]');
  expect(await projectRemoteSessionResult('local-db:sessions:list', [{ id: 'old', source: 'bot' }, { id: 'not-yet-checked' }])).toEqual([]);
  expect(await projectRemoteBotPush({ sessionId: 'old' }, 'maker:event')).toBeNull();
  expect(await projectRemoteBotPush({ source: 'bot' }, 'maker:event')).toBeNull();
  expect(await projectRemoteBotPush({ online: true }, 'devices:changed')).toEqual({ online: true });
});

it('rejects a lookup result crossing a replaced account adapter', async () => {
  let release!: (value: 'ordinary') => void;
  setRemoteBotSessionLookup(() => new Promise(resolve => { release = resolve; }));
  const checking = assertRemoteBotInvocationAllowed(['old'], 'maker:send');
  setRemoteBotSessionLookup(async () => 'ordinary');
  release('ordinary');
  await expect(checking).rejects.toThrow('[NOT_FOUND]');
});

it('filters retired manifests and buffered pushes without touching unrelated payloads', async () => {
  setRemoteBotSessionLookup(async id => id === 'legacy' ? 'hidden' : 'ordinary');
  const document = { id: 'docs', resourceKind: 'document' };
  expect(await projectRemoteSessionResult('maker:remote-resources:manifest', {
    protocolVersion: 1, collections: [document, { id: 'teammates', resourceKind: 'bot' },
      { id: 'bot-groups', resourceKind: 'group' }, { id: 'routines', resourceKind: 'routine' }],
  })).toEqual({ protocolVersion: 1, collections: [document] });
  expect(await projectRemoteBotPush({ message: { sessionId: 'legacy' } }, 'local-db:messages:created')).toBeNull();
  const payload = { sessionId: 'ordinary', message: { text: 'kept' } };
  expect(await projectRemoteBotPush(payload, 'maker:event')).toBe(payload);
});
