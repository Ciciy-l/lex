import { expect, it, vi } from 'vitest';
import type { BotRemoteResourceSource } from '../bots.js';

const db = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  memory: {
    list: vi.fn(),
    read: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock('../bots.js', () => ({
  getBotRemoteResourceSource: db.get,
  listBotRemoteResourceSources: db.list,
  getBotMemoryService: () => db.memory,
}));

import { remoteResourceRegistry } from '../../../device-link/remoteResourceRegistry.js';
import { registerBotRemoteResourceProvider } from '../botRemoteResourceProvider.js';

it('rejects a previously discovered hidden companion and allows it again after restoration', async () => {
  const source: BotRemoteResourceSource = {
    id: 'bot-1', name: 'Sora', description: 'Designer',
    avatar: '', avatarColor: 'teal', status: 'active',
    canonicalSessionId: 'session-1', lastMessagePreview: 'Private work',
    lastMessageAt: 100, lastMessageRole: 'assistant', needsAttention: false,
    hiddenAt: null, pinnedAt: null, activityAt: 100, currentVersion: 1, updatedAt: 100,
  };
  db.get.mockImplementation(async () => ({ ...source }));
  db.list.mockImplementation(async () => [{ ...source }]);
  registerBotRemoteResourceProvider();
  const context = { controllerDeviceId: 'remote-mac' };
  const client = { protocolVersion: 1, primitives: ['markdown'] };
  const list = () => remoteResourceRegistry.list(context, { client, collectionId: 'teammates' });
  const discovered = (await list()).items[0];
  const get = () => remoteResourceRegistry.get(context, { client, ref: discovered.ref });

  await expect(get()).resolves.toMatchObject({
    display: { title: 'Sora' },
    links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'session-1' } }],
  });
  source.hiddenAt = 200;
  expect((await list()).items).toEqual([]);
  await expect(get()).rejects.toMatchObject({
    code: 'NOT_FOUND', message: 'remote resource does not exist',
  });
  expect(db.get).toHaveBeenLastCalledWith('bot-1');

  source.hiddenAt = null;
  source.status = 'archived';
  expect((await list()).items).toEqual([]);
  await expect(get()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  source.status = 'active';
  expect((await list()).items).toHaveLength(1);
  await expect(get()).resolves.toMatchObject({ display: { title: 'Sora' } });
});

it('routes the existing Bot resource provider to owner-bound memory resources', async () => {
  const source: BotRemoteResourceSource = {
    id: 'bot-1', name: 'Sora', description: 'Designer', avatar: '', avatarColor: 'teal', status: 'active',
    canonicalSessionId: 'session-1', lastMessagePreview: '', lastMessageAt: 100, lastMessageRole: 'assistant',
    needsAttention: false, hiddenAt: null, pinnedAt: null, activityAt: 100, currentVersion: 1, updatedAt: 100,
  };
  db.get.mockResolvedValue(source);
  db.memory.list.mockResolvedValue([{ filename: 'feedback_style.md', type: 'feedback', title: 'Style', preview: 'Concise', updatedAt: '2026-10-04T00:00:00.000Z' }]);
  const resource = await remoteResourceRegistry.get({ controllerDeviceId: 'phone', assertCurrent: vi.fn() }, {
    client: { protocolVersion: 1, primitives: ['search'] },
    ref: { collectionId: 'teammates', kind: 'bot', id: 'settings:bot-1/memory' },
  });
  expect(resource.ref.id).toBe('settings:bot-1/memory');
  expect(resource.blocks?.find((block) => block.id === 'memory-feedback')?.data).toMatchObject({ count: 1 });
  expect(db.memory.list).toHaveBeenCalledWith('bot-1', undefined, expect.any(Function));
});
