import { describe, expect, it, vi } from 'vitest';
import { DeviceLinkError } from '@cindy/device-link';

import {
  MOBILE_REMOTE_RESOURCE_PRIMITIVES,
  getRemoteResource,
  invokeRemoteResourceAction,
  discoverRemoteHomeCollections,
  remoteResourceDiscoveryTargets,
  isRemoteResourcesUnsupported,
  mergeRemoteCollectionHostShards,
  normalizeRemoteCollectionItems,
  parseRemoteResourceTargets,
  serializeRemoteResourceTargets,
} from '@/device-link/remoteResources';
import type { RemoteInvoke } from '@/device-link/mobileMakerTransport';

const targets = [
  { deviceId: 'mac-1', deviceName: 'Studio' },
  { deviceId: 'mac-2', deviceName: 'Laptop' },
];

describe('retired resource collections', () => {
  it.each(['bot', 'bot-group'])('rejects %s resources in arbitrary live or cached collections', async kind => {
    const invoke = vi.fn();
    const ref = { collectionId: 'custom', kind, id: 'old' };
    await expect(getRemoteResource(invoke, targets[0], ref)).rejects.toThrow('Unsupported');
    await expect(invokeRemoteResourceAction(invoke, targets[0], { collectionId: 'custom', actionId: 'open', resourceRef: ref })).rejects.toThrow('Unsupported');
    expect(invoke).not.toHaveBeenCalled();
    const item = { ref, display: { title: 'Old' }, revision: '1', links: [] };
    expect(normalizeRemoteCollectionItems({ items: [item] }, 'custom')).toEqual([]);
    expect(mergeRemoteCollectionHostShards([{ key: 'old', host: targets[0], item }], [], new Set(), targets)).toEqual([]);
    const previous = [{ id: 'custom', title: 'Old', resourceKind: kind, placement: 'home-scope', targets }];
    expect(remoteResourceDiscoveryTargets([{ deviceId: 'mac-1', name: 'Studio', state: 'offline', canOpen: false }], previous)).toEqual([]);
    const document = { id: 'docs', title: 'Documents', resourceKind: 'document', placement: 'home-scope', targets };
    const live = vi.fn(async () => ({ protocolVersion: 1, collections: [...previous, document] })) as RemoteInvoke;
    expect((await discoverRemoteHomeCollections(live, targets, 'en', previous)).map(row => row.id)).toEqual(['docs']);
    const offline = vi.fn(async () => { throw new Error('offline'); }) as RemoteInvoke;
    expect((await discoverRemoteHomeCollections(offline, targets, 'en', [...previous, document])).map(row => row.id)).toEqual(['docs']);
  });
  it.each(['teammates', 'bot-groups', 'routines'])('rejects %s even when an old screen advertises its primitive', async collectionId => {
    const invoke = vi.fn();
    await expect(getRemoteResource(invoke, targets[0], { collectionId, kind: 'bot', id: 'old' }, 'en', ['bot-group-chat']))
      .rejects.toThrow('Unsupported');
    expect(invoke).not.toHaveBeenCalled();
    expect(normalizeRemoteCollectionItems({ items: [{ ref: { collectionId, kind: 'bot', id: 'old' }, display: { title: 'Old' }, revision: '1', links: [] }] }, collectionId)).toEqual([]);
  });
  it('does not resurrect retired collections from a live manifest or its offline fallback', async () => {
    const previous = ['teammates', 'bot-groups', 'routines'].map(id => ({ id, title: id, resourceKind: 'bot', targets }));
    const invoke = vi.fn(async () => ({ protocolVersion: 1, collections: previous.map(row => ({ ...row, placement: 'home-scope' })) })) as RemoteInvoke;
    await expect(discoverRemoteHomeCollections(invoke, targets, 'en', previous)).resolves.toEqual([]);
    expect(remoteResourceDiscoveryTargets([{ deviceId: 'mac-1', name: 'Studio', state: 'offline', canOpen: false }], previous)).toEqual([]);
  });
});

describe('remote resource discovery', () => {
  it('keeps a discovered offline host while excluding revoked and disabled hosts', async () => {
    const previous = [{ id: 'projects', title: 'Projects', resourceKind: 'project', placement: 'home-scope', targets }];
    const selected = remoteResourceDiscoveryTargets([
      { deviceId: 'mac-1', name: 'Studio', canOpen: false, state: 'offline' },
      { deviceId: 'mac-2', name: 'Laptop', canOpen: false, state: 'access_revoked' },
      { deviceId: 'mac-3', name: 'Disabled', canOpen: false, state: 'remote_disabled' },
    ], previous);
    expect(selected).toEqual([targets[0]]);
    const invoke = vi.fn(async () => { throw new Error('offline'); }) as RemoteInvoke;
    const collections = await discoverRemoteHomeCollections(invoke, selected, 'en', previous);
    expect(collections[0]?.targets).toEqual([targets[0]]);
  });

  it('advertises only primitives implemented by the current mobile shell', () => {
    expect(MOBILE_REMOTE_RESOURCE_PRIMITIVES).toEqual([
      'status', 'session-link', 'search', 'list', 'form', 'action', 'markdown',
    ]);
  });

  it('merges host-advertised home collections without knowing their feature module', async () => {
    const invoke = vi.fn(async (deviceId: string) => ({
      protocolVersion: 1,
      collections: [{
        id: 'projects',
        resourceKind: 'project',
        placement: 'home-scope',
        title: {
          fallback: 'Projects',
          translations: { 'zh-CN': '所有项目' },
        },
        futureField: deviceId,
      }],
    })) as RemoteInvoke;

    await expect(discoverRemoteHomeCollections(invoke, targets, 'zh-CN')).resolves.toEqual([{
      id: 'projects',
      title: '所有项目',
      resourceKind: 'project',
      placement: 'home-scope',
      iconName: undefined,
      targets,
    }]);
  });

  it('surfaces an all-host transient failure so callers can retain their last manifest', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('temporarily offline');
    }) as RemoteInvoke;

    await expect(discoverRemoteHomeCollections(invoke, targets, 'en'))
      .rejects.toThrow('temporarily offline');
  });

  it('treats an old host as unsupported while retaining collections from newer hosts', async () => {
    const invoke = vi.fn(async (deviceId: string) => {
      if (deviceId === 'mac-1') throw new DeviceLinkError('CHANNEL_NOT_ALLOWED', 'old desktop');
      return {
        protocolVersion: 1,
        collections: [{
          id: 'future-module',
          resourceKind: 'future-resource',
          placement: 'home-scope',
          title: 'Future module',
        }],
      };
    }) as RemoteInvoke;

    await expect(discoverRemoteHomeCollections(invoke, targets, 'en')).resolves.toMatchObject([{
      id: 'future-module',
      targets: [{ deviceId: 'mac-2' }],
    }]);
    expect(isRemoteResourcesUnsupported(
      Object.assign(new Error('wrapped'), { code: 'DEVICE_LINK_CHANNEL_NOT_ALLOWED' }),
    )).toBe(true);
  });

  it('keeps the last manifest when unsupported hosts are mixed with a transient failure', async () => {
    const invoke = vi.fn(async (deviceId: string) => {
      if (deviceId === 'mac-1') throw new DeviceLinkError('CHANNEL_NOT_ALLOWED', 'old desktop');
      throw new Error('temporarily offline');
    }) as RemoteInvoke;

    await expect(discoverRemoteHomeCollections(invoke, targets, 'en'))
      .rejects.toThrow('temporarily offline');
  });

  it('retains a failed host manifest shard when another supported host returns empty', async () => {
    const invoke = vi.fn(async (deviceId: string) => {
      if (deviceId === 'mac-1') throw new Error('temporarily offline');
      return { protocolVersion: 1, collections: [] };
    }) as RemoteInvoke;
    const previous = [{
      id: 'projects',
      title: 'Projects',
      resourceKind: 'project',
      placement: 'home-scope',
      targets: [targets[0]],
    }];

    await expect(discoverRemoteHomeCollections(invoke, targets, 'en', previous))
      .resolves.toEqual(previous);
  });
});

describe('remote resource response boundaries', () => {
  it('keeps valid additive items and drops malformed or cross-collection items', () => {
    expect(normalizeRemoteCollectionItems({ items: [
      {
        ref: { collectionId: 'projects', kind: 'project', id: 'project-1' },
        display: { title: 'Cindy', futureDisplay: true },
        links: [],
        revision: '1',
        futureField: true,
      },
      {
        ref: { collectionId: 'other', kind: 'project', id: 'project-2' },
        display: { title: 'Wrong scope' },
        links: [],
        revision: '1',
      },
      { display: null },
    ] }, 'projects')).toHaveLength(1);
  });

  it('normalizes hostile optional display and link fields before rendering', () => {
    const [item] = normalizeRemoteCollectionItems({ items: [{
      ref: { collectionId: 'projects', kind: 'project', id: 'project-1' },
      display: {
        title: 'Cindy',
        timestamp: 9e15,
        avatar: { kind: 'emoji', value: { boom: true }, fallbackText: 'C' },
        status: { label: 42 },
      },
      links: [
        { rel: 'conversation', target: { kind: 'session', sessionId: 42 } },
        { rel: 'conversation', target: { kind: 'session', sessionId: 'session-1' } },
      ],
      revision: '1',
    }] }, 'projects');

    expect(item).toEqual({
      ref: { collectionId: 'projects', kind: 'project', id: 'project-1' },
      display: { title: 'Cindy' },
      links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'session-1' } }],
      revision: '1',
    });
  });

  it('replaces only successful host shards and preserves provider order', () => {
    const item = (deviceId: string, id: string) => ({
      key: `${deviceId}:${id}`,
      host: targets.find((target) => target.deviceId === deviceId)!,
      item: {
        ref: { collectionId: 'projects', kind: 'project', id },
        display: { title: id },
        links: [],
        revision: '1',
      },
    });
    const current = [item('mac-1', 'stale-1'), item('mac-2', 'old-2')];
    const next = [item('mac-2', 'provider-first'), item('mac-2', 'provider-second')];

    expect(mergeRemoteCollectionHostShards(
      current,
      next,
      new Set(['mac-2']),
      targets,
    ).map((entry) => entry.item.ref.id)).toEqual([
      'stale-1',
      'provider-first',
      'provider-second',
    ]);
  });
});

describe('remote resource route targets', () => {
  it('round-trips bounded host identities and rejects malformed params', () => {
    expect(parseRemoteResourceTargets(serializeRemoteResourceTargets(targets))).toEqual(targets);
    expect(parseRemoteResourceTargets('{broken')).toEqual([]);
    expect(parseRemoteResourceTargets(JSON.stringify([{ deviceId: '', deviceName: 'Nope' }])))
      .toEqual([]);
  });
});

describe('portable task controls', () => {
  it('preserves only bounded actions and known primitive data, keeping unknown blocks readable', async () => {
    const ref = { collectionId: 'workflow', kind: 'session', id: 'task' };
    const invoke = vi.fn(async () => ({
      ref, revision: '2', display: { title: 'Test' }, links: [],
      actions: [
        { id: 'start', label: 'Start' }, { id: 'continue', label: 'Continue', disabled: true },
        { id: 'form', label: 'Form', fields: [{ id: 'secret' }] },
        { id: 'confirm', label: 'Confirm', confirmation: { title: 'Sure?' } },
        { id: 'bad-confirm', label: 'Bad', confirmation: { title: '' } },
        { id: 'bad-body', label: 'Bad', confirmation: { title: 'Sure?', body: 42 } },
        { id: 'null-confirm', label: 'Bad', confirmation: null },
        { id: 'x'.repeat(513), label: 'Too long' },
      ],
      blocks: [
        { id: 'workflow', primitive: 'session-controls', fallbackMarkdown: 'Installing dependencies', data: { input: 'blocked', busy: true, path: '/private' } },
        { id: 'future', primitive: 'future-widget', fallbackMarkdown: 'Readable fallback', data: { html: '<script>' } },
      ],
    })) as RemoteInvoke;
    const card = await getRemoteResource(invoke, targets[0], ref);
    expect(card.actions).toEqual([{ id: 'start', label: 'Start', disabled: false }, { id: 'continue', label: 'Continue', disabled: true }, { id: 'confirm', label: 'Confirm', disabled: false, confirmation: { title: 'Sure?' } }]);
    expect(card.blocks?.[0].data).toEqual({ input: 'blocked', busy: true });
    expect(card.blocks?.[1]).toEqual({ id: 'future', primitive: 'future-widget', fallbackMarkdown: 'Readable fallback' });
    expect(JSON.stringify(card)).not.toContain('/private');
  });
});

it('preserves additive public generation state without interpreting unknown future phases', () => {
  const input = (generation?: unknown) => ({ items: [{ ref: { collectionId: 'projects', kind: 'project', id: 'project' },
    display: { title: 'Cindy', generation }, links: [], revision: '1' }] });
  expect(normalizeRemoteCollectionItems(input({ phase: 'replying', startedAt: 123 }), 'projects')[0].display.generation)
    .toEqual({ phase: 'replying', startedAt: 123 });
  expect(normalizeRemoteCollectionItems(input(), 'projects')[0].display.generation).toBeUndefined();
  expect(normalizeRemoteCollectionItems(input({ phase: {}, startedAt: Infinity }), 'projects')[0].display.generation).toBeUndefined();
});

describe('unknown resource primitive', () => {
  const ref = { collectionId: 'reports', kind: 'report', id: 'g1' };
  const response = {
    ref, revision: '1', display: { title: '官网介绍页' }, links: [],
    blocks: [{ id: 'chat', primitive: 'future-chart', fallbackMarkdown: '**阿布**: 写好了', data: { id: 'g1', messages: [{ id: 'm1' }] } }],
  };

  it('keeps unknown data inert even when an old screen advertises an extra primitive', async () => {
    const invoke = vi.fn(async () => response) as RemoteInvoke;
    const resource = await getRemoteResource(invoke, targets[0], ref, 'zh-CN', ['future-chart']);
    expect(resource.blocks?.[0]).toEqual({ id: 'chat', primitive: 'future-chart', fallbackMarkdown: '**阿布**: 写好了' });
    const request = (invoke as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![2] as [{ client: { primitives: string[] } }];
    expect(request[0].client.primitives).toEqual([...MOBILE_REMOTE_RESOURCE_PRIMITIVES, 'future-chart']);
  });

  it('never hands the group data to an ordinary resource view', async () => {
    const invoke = vi.fn(async () => response) as RemoteInvoke;
    const resource = await getRemoteResource(invoke, targets[0], ref);
    expect(resource.blocks?.[0]).toEqual({ id: 'chat', primitive: 'future-chart', fallbackMarkdown: '**阿布**: 写好了' });
  });
});
