import { expect, it, vi } from 'vitest';
import type { BotRemoteResourceSource } from '../bots.js';

const db = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  settings: vi.fn(),
  skills: vi.fn(),
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
  getBotRemoteSettingsSource: db.settings,
  getBotMemoryService: () => db.memory,
}));
vi.mock('../../../maker-ipc/botSkillService.js', () => ({
  listBotSkillsForBot: db.skills,
  readBotSkillForBot: vi.fn(),
  saveBotSkillForSession: vi.fn(),
  deleteBotSkillForBot: vi.fn(),
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
    links: expect.arrayContaining([{ rel: 'conversation', target: { kind: 'session', sessionId: 'session-1' } }]),
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

it('advertises a reachable create resource only to form-capable controllers', async () => {
  const source: BotRemoteResourceSource = {
    id: 'bot-1', name: 'Sora', description: 'Designer', avatar: '', avatarColor: 'teal', status: 'active',
    canonicalSessionId: 'session-1', lastMessagePreview: '', lastMessageAt: 100, lastMessageRole: 'assistant',
    needsAttention: false, hiddenAt: null, pinnedAt: null, activityAt: 100, currentVersion: 1, updatedAt: 100,
  };
  db.list.mockResolvedValue([source]);
  const context = { controllerDeviceId: 'phone-create' };
  await expect(remoteResourceRegistry.list(context, {
    client: { protocolVersion: 1, primitives: ['markdown'] }, collectionId: 'teammates', limit: 20,
  })).resolves.toMatchObject({ items: [{ ref: { id: 'bot-1' } }] });
  await expect(remoteResourceRegistry.list(context, {
    client: { protocolVersion: 1, primitives: ['form'] }, collectionId: 'teammates', limit: 20,
  })).resolves.toMatchObject({ items: [{ ref: { id: 'create' }, display: { title: { fallback: 'New Teammate' } } }, { ref: { id: 'bot-1' } }] });
});

it('keeps the settings namespace ref when projecting the host settings resource', async () => {
  const source: BotRemoteResourceSource = {
    id: 'bot-1', name: 'Sora', description: 'Designer', avatar: '', avatarColor: 'teal', status: 'active',
    canonicalSessionId: 'session-1', lastMessagePreview: '', lastMessageAt: 100, lastMessageRole: 'assistant',
    needsAttention: false, hiddenAt: null, pinnedAt: null, activityAt: 100, currentVersion: 1, updatedAt: 100,
  };
  db.get.mockResolvedValue(source);
  db.settings.mockResolvedValue({
    source, identity: '', userContext: '', memory: true, permissions: 'ask', modelChain: [],
    followsDefault: true, skills: [], connections: [], toolsets: [],
  });
  db.skills.mockResolvedValue([]);
  const peer = {};
  const client = { protocolVersion: 1, primitives: ['form', 'list', 'action', 'markdown'] };
  const resource = await remoteResourceRegistry.get(
    { controllerDeviceId: 'phone-settings', client: peer, linkEpoch: 1, assertCurrent: vi.fn() },
    { client, ref: { collectionId: 'teammates', kind: 'bot', id: 'settings:bot-1' } },
  );
  expect(resource.ref.id).toBe('settings:bot-1');
  expect(resource.blocks?.some((block) => block.id === 'avatar')).toBe(true);
  expect(resource.blocks?.some((block) => block.id === 'skills')).toBe(true);
});

it('keeps long bot and filename ids reachable through list, detail, update, and delete', async () => {
  const botId = 'bot_' + 'x'.repeat(120);
  const filename = 'feedback_' + 'memory-'.repeat(8) + 'tail.md';
  const source: BotRemoteResourceSource = {
    id: botId, name: 'Long Sora', description: 'Designer', avatar: '', avatarColor: 'teal', status: 'active',
    canonicalSessionId: 'session-long', lastMessagePreview: '', lastMessageAt: 100, lastMessageRole: 'assistant',
    needsAttention: false, hiddenAt: null, pinnedAt: null, activityAt: 100, currentVersion: 1, updatedAt: 100,
  };
  const current = { filename, type: 'feedback' as const, title: 'Style', body: 'Concise', updatedAt: '2026-10-04T00:00:00.000Z' };
  db.get.mockResolvedValue(source);
  db.list.mockResolvedValue([source]);
  db.memory.list.mockResolvedValue([{ filename, type: current.type, title: current.title, preview: current.body, updatedAt: current.updatedAt }]);
  db.memory.read.mockResolvedValue(current);
  db.memory.update.mockResolvedValue(current);
  db.memory.delete.mockResolvedValue(undefined);
  const context = { controllerDeviceId: 'phone-long', linkEpoch: 2, assertCurrent: vi.fn() };
  const client = { protocolVersion: 1, primitives: ['search', 'list', 'form', 'action'] };
  const base = { collectionId: 'teammates', kind: 'bot', id: 'settings:' + botId + '/memory' };
  const list = await remoteResourceRegistry.get(context, { client, ref: base });
  const entry = (list.blocks ?? []).flatMap((block) => {
    const data = block.data && typeof block.data === 'object' ? block.data as { entries?: unknown[] } : {};
    return data.entries ?? [];
  }).find((item) => item && typeof item === 'object' && 'resourceId' in item) as { resourceId: string } | undefined;
  expect(entry?.resourceId).toMatch(/\/memory\/h[a-f0-9]{12}$/);
  const detail = await remoteResourceRegistry.get(context, { client, ref: { ...base, id: entry!.resourceId } });
  await remoteResourceRegistry.invoke(context, {
    client, collectionId: 'teammates', resourceRef: detail.ref, actionId: 'memory-update',
    input: { title: 'Updated', body: 'New', expectedUpdatedAt: current.updatedAt },
  });
  await remoteResourceRegistry.invoke(context, {
    client, collectionId: 'teammates', resourceRef: detail.ref, actionId: 'memory-delete',
    input: { expectedUpdatedAt: current.updatedAt },
  });
  expect(db.memory.update).toHaveBeenCalledWith(expect.objectContaining({ botId, filename }), expect.any(Function));
  expect(db.memory.delete).toHaveBeenCalledWith(expect.objectContaining({ botId, filename }), expect.any(Function));
});
