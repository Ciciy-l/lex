import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { encodeProviderCatalogPage, readProviderCatalog, PROVIDER_CATALOG_PAGES_CAPABILITY } from '../providerCatalogTransport.js';
import { encodeReliableFrames } from '../transport.js';
import type { InvokePayload, InvokeResultPayload } from '../protocol.js';

const revisionOf = (json: string) => createHash('sha256').update(json).digest('hex');
const payload: InvokePayload = { channel: 'maker:provider:list', args: [{ capabilities: ['provider-logo-kinds-v2'] }] };
const catalog = (count = 1) => ({
  providers: [{ id: 'custom', connected: true, models: { pi: Array.from({ length: count }, (_, i) => ({
    id: `model-${i}`, name: `模型 🐈 ${i}`, description: '引用 "\\\n🐈'.repeat(80), efforts: ['low', 'high'],
  })) } }],
  providerOrder: ['custom'], modelVisibilityOverrides: { 'pi:custom:model-0': false },
});

describe('provider catalog pages', () => {
  it('round-trips every model/option in a >4MiB catalog through bounded reliable frames', async () => {
    const value = catalog(4000);
    expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(4 * 1024 * 1024);
    const request = vi.fn(async (next: InvokePayload): Promise<InvokeResultPayload> => {
      const result = encodeProviderCatalogPage(next.args, value, revisionOf);
      const envelope = { v: 1 as const, kind: 'invoke-result' as const, src: 'host', dst: 'phone', id: 'read', payload: { ok: true as const, result } };
      expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThan(2 * 1024 * 1024);
      expect(() => encodeReliableFrames(envelope, 'stream', 1)).not.toThrow();
      return envelope.payload;
    });
    expect(await readProviderCatalog(payload, request)).toEqual({ ok: true, result: value });
    expect(request.mock.calls.length).toBeGreaterThan(1);
    expect(payload.args).toEqual([{ capabilities: ['provider-logo-kinds-v2'] }]);
  });

  it('keeps old hosts, old controllers and unrelated invokes compatible', async () => {
    const value = catalog();
    expect(encodeProviderCatalogPage(payload.args, value, revisionOf)).toBe(value);
    const reply = { ok: true as const, result: value };
    const legacy = vi.fn(async () => reply);
    expect(await readProviderCatalog(payload, legacy)).toBe(reply);
    expect(legacy).toHaveBeenCalledTimes(1);
    const unrelated = { channel: 'maker:list-active', args: [] };
    await readProviderCatalog(unrelated, legacy);
    expect(legacy).toHaveBeenLastCalledWith(unrelated);
  });

  it('rejects changed snapshots, malformed cursors and out-of-order pages', async () => {
    const value = catalog(1000);
    const options = { capabilities: [PROVIDER_CATALOG_PAGES_CAPABILITY] };
    expect(() => encodeProviderCatalogPage([{ ...options, catalogPage: { offset: -1, revision: 'x' } }], value, revisionOf)).toThrow('Invalid provider catalog cursor');
    let calls = 0;
    await expect(readProviderCatalog(payload, async next => {
      calls++;
      return { ok: true, result: encodeProviderCatalogPage(next.args, calls > 1 ? catalog(999) : value, revisionOf) };
    })).rejects.toThrow('Provider catalog changed');
    await expect(readProviderCatalog(payload, async next => ({
      ok: true, result: { ...(encodeProviderCatalogPage(next.args, value, revisionOf) as object), offset: 1 },
    }))).rejects.toThrow('Inconsistent provider catalog page');
  });

  it('propagates a later authorization failure without exposing a partial catalog', async () => {
    let calls = 0;
    const denied = { ok: false as const, error: { code: 'ACCESS_REVOKED' as const, message: 'revoked' } };
    expect(await readProviderCatalog(payload, async next => ++calls > 1 ? denied : ({
      ok: true, result: encodeProviderCatalogPage(next.args, catalog(1000), revisionOf),
    }))).toBe(denied);
    expect(calls).toBe(2);
  });
});
