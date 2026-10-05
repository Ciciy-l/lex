import { describe, expect, it, vi } from 'vitest';
import { getRemoteResource, MOBILE_REMOTE_RESOURCE_PRIMITIVES } from '../device-link/remoteResources';
import { normalizeRemoteActions, normalizeRemoteBlocks } from '../device-link/remoteResourceContent';
import type { RemoteInvoke } from '../device-link/mobileMakerTransport';

const ref = { collectionId: 'teammates', kind: 'bot', id: 'settings:bot-1/avatar' };
const action = {
  id: 'avatar',
  label: { fallback: 'Save', translations: { 'zh-CN': '保存' } },
  fields: [{ id: 'avatarImageBase64', label: { fallback: 'Avatar' }, kind: 'text', required: true }],
};
const block = {
  id: 'avatar',
  primitive: 'form',
  fallbackMarkdown: 'Avatar',
  data: { actionId: 'avatar', values: { avatarImageBase64: '' } },
};

describe('remote resource content through the mobile boundary', () => {
  it('retains portable Bot settings forms and advertises the complete client surface', async () => {
    const invoke = vi.fn(async () => ({
      ref,
      display: { title: { fallback: 'Avatar' } },
      revision: '1',
      links: [],
      actions: [action],
      blocks: [block],
    })) as RemoteInvoke;
    const result = await getRemoteResource(invoke, { deviceId: 'host', deviceName: 'Mac' }, ref, 'en');
    expect(result.actions?.[0]?.id).toBe('avatar');
    expect(result.blocks?.[0]?.data).toEqual(block.data);
    expect(vi.mocked(invoke).mock.calls[0]![2]).toMatchObject([{
      client: { primitives: [...MOBILE_REMOTE_RESOURCE_PRIMITIVES], locale: 'en' },
    }]);
  });

  it('rejects an entire action when one editable field is unsupported or oversized', () => {
    expect(normalizeRemoteActions([{ ...action, fields: [...action.fields, { id: 'future', kind: 'future', label: 'Future' }] }])).toEqual([]);
    expect(normalizeRemoteActions([{ ...action, fields: Array.from({ length: 65 }, (_, i) => ({ id: String(i), kind: 'text', label: 'Field' })) }])).toEqual([]);
  });

  it('does not truncate editable JSON or retain prototype-bearing data', () => {
    expect(normalizeRemoteBlocks([{ ...block, data: { ...block.data, values: { avatarImageBase64: 'x'.repeat(1_000_001) } } }])).toEqual([]);
    expect(normalizeRemoteBlocks([{ ...block, data: JSON.parse('{"__proto__":{"polluted":true}}') }])).toEqual([]);
    expect(normalizeRemoteBlocks([block])).toEqual([block]);
  });

  it('retains empty select choices and localized confirmations without inventing defaults', () => {
    const value = {
      ...action,
      confirmation: { title: { fallback: 'Remove', translations: { 'zh-CN': '删除' } } },
      fields: [{ id: 'model', label: 'Model', kind: 'select', options: [{ value: '', label: 'None' }] }],
    };
    expect(normalizeRemoteActions([value])).toEqual([value]);
  });
});
