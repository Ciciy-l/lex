import { describe, expect, it, vi } from 'vitest';
import { createBotRemoteMemoryResource, invokeBotRemoteMemory } from '../botRemoteMemory.js';
import type { BotMemoryDetail, BotMemorySummary } from '../../../../shared/botMemory.js';

const summary = (filename: string, type: BotMemorySummary['type'], title: string): BotMemorySummary => ({
  filename, type, title, preview: `${title} preview`, updatedAt: '2026-10-04T00:00:00.000Z',
});
const detail = (filename: string, title = 'Preference'): BotMemoryDetail => ({
  filename, type: 'feedback', title, body: 'Use concise answers.', updatedAt: '2026-10-04T00:00:00.000Z',
});

describe('remote Bot memory resource', () => {
  it('groups/searches entries and emits a CAS-bound form and delete confirmation', async () => {
    const service = {
      list: vi.fn(async (_botId: string, query?: string) => query ? [summary('feedback_style.md', 'feedback', 'Style')] : [
        summary('user_about.md', 'user', 'About'), summary('feedback_style.md', 'feedback', 'Style'),
      ]),
      read: vi.fn(async () => detail('feedback_style.md')),
      update: vi.fn(async () => detail('feedback_style.md', 'Updated')),
      delete: vi.fn(async () => undefined),
    };
    const context = { controllerDeviceId: 'phone-a', linkEpoch: 3, assertCurrent: vi.fn() };
    const list = await createBotRemoteMemoryResource(service, context, 'bot-a', 'Sora');
    expect(list.ref.id).toBe('settings:bot-a/memory');
    expect(list.blocks?.map((block) => block.id)).toEqual(['search', 'memory-user', 'memory-feedback']);
    expect(list.blocks?.find((block) => block.id === 'memory-feedback')?.data).toMatchObject({ count: 1 });
    const filtered = await createBotRemoteMemoryResource(service, context, 'bot-a', 'Sora', 'style');
    expect(service.list).toHaveBeenLastCalledWith('bot-a', 'style', expect.any(Function));
    expect(filtered.blocks?.some((block) => block.id === 'memory-feedback')).toBe(true);
    const resource = await createBotRemoteMemoryResource(service, context, 'bot-a', 'Sora', undefined, 'feedback_style');
    expect(resource.revision).toBe('2026-10-04T00:00:00.000Z');
    expect(resource.actions).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'memory-update' }), expect.objectContaining({ id: 'memory-delete', tone: 'destructive' })]));
    expect(resource.blocks?.find((block) => block.id === 'entry')?.data).toMatchObject({ values: { expectedUpdatedAt: resource.revision } });
  });

  it('passes the captured controller guard through the real mutation service boundary', async () => {
    const guard = vi.fn();
    const current = detail('feedback_style.md');
    const service = {
      list: vi.fn(async () => [summary(current.filename, current.type, current.title)]),
      read: vi.fn(async () => current),
      update: vi.fn(async (_input: unknown, operationGuard?: () => void) => { operationGuard?.(); return current; }),
      delete: vi.fn(async (_input: unknown, operationGuard?: () => void) => { operationGuard?.(); }),
    };
    const context = { controllerDeviceId: 'phone-a', linkEpoch: 9, assertCurrent: guard };
    await invokeBotRemoteMemory(service, context, 'bot-a', current.filename, 'memory-update', {
      title: 'Mine', body: 'New body', expectedUpdatedAt: current.updatedAt,
    });
    expect(service.update).toHaveBeenCalledWith(expect.objectContaining({ botId: 'bot-a', expectedUpdatedAt: current.updatedAt }), expect.any(Function));
    expect(guard).toHaveBeenCalled();
    await invokeBotRemoteMemory(service, context, 'bot-a', current.filename, 'memory-delete', { expectedUpdatedAt: current.updatedAt });
    expect(service.delete).toHaveBeenCalledWith(expect.objectContaining({ filename: current.filename }), expect.any(Function));
  });

  it('does not let a guard failure turn into a successful mutation receipt', async () => {
    let revoked = false;
    const context = { controllerDeviceId: 'phone-a', linkEpoch: 1, assertCurrent: () => { if (revoked) throw new Error('[ACCESS_REVOKED] Device link changed'); } };
    const service = {
      list: async () => [], read: async () => detail('feedback_style.md'),
      update: async (_input: unknown, guard?: () => void) => { revoked = true; guard?.(); return detail('feedback_style.md'); },
      delete: async () => undefined,
    };
    await expect(invokeBotRemoteMemory(service, context, 'bot-a', 'feedback_style.md', 'memory-update', {
      title: 'Mine', expectedUpdatedAt: '2026-10-04T00:00:00.000Z',
    })).rejects.toThrow('ACCESS_REVOKED');
  });
});
