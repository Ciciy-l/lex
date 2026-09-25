import { describe, expect, it, vi } from 'vitest';
import { listCodexModels } from './list-models.js';

const model = (id: string) => ({
  id,
  model: id,
  displayName: id,
  description: '',
  hidden: false,
  supportedReasoningEfforts: [],
  defaultReasoningEffort: 'medium' as const,
  additionalSpeedTiers: [],
  serviceTiers: [],
  isDefault: false,
});

describe('Codex model list pagination', () => {
  it('reads all pages, including an empty intermediate page', async () => {
    const readPage = vi.fn()
      .mockResolvedValueOnce({ data: [model('one')], nextCursor: 'two' })
      .mockResolvedValueOnce({ data: [], nextCursor: 'three' })
      .mockResolvedValueOnce({ data: [model('three')], nextCursor: null });

    await expect(listCodexModels(readPage)).resolves.toEqual([model('one'), model('three')]);
    expect(readPage.mock.calls).toEqual([[null], ['two'], ['three']]);
  });

  it('rejects repeated cursors without publishing a partial catalog', async () => {
    const readPage = vi.fn().mockResolvedValue({ data: [model('partial')], nextCursor: 'same' });

    await expect(listCodexModels(readPage)).rejects.toThrow('cursor');
    expect(readPage).toHaveBeenCalledTimes(2);
  });

  it('rejects RPC failures and malformed pages', async () => {
    await expect(listCodexModels(vi.fn().mockRejectedValue(new Error('offline'))))
      .rejects.toThrow('offline');
    await expect(listCodexModels(vi.fn().mockResolvedValue({ nextCursor: null } as never)))
      .rejects.toThrow('Invalid Codex model list');
  });

  it('stops at the bounded page limit', async () => {
    let cursor = 0;
    const readPage = vi.fn(async () => ({ data: [], nextCursor: 'next-' + cursor++ }));

    await expect(listCodexModels(readPage)).rejects.toThrow('page limit');
    expect(readPage).toHaveBeenCalledTimes(100);
  });
});
