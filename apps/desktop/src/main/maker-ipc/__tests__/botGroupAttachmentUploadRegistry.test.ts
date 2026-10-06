import http from 'node:http';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  presign: null as ((size: number, ext: string, contentType: string) => Promise<{ putUrl: string; key: string; expiresAt: string }>) | null,
  presignCalls: 0,
  removed: [] as string[],
}));

vi.mock('../../device-link/mediaTransfer.js', () => ({
  presignPutForRemoteAttachment: (...args: [number, string, string]) => {
    if (!h.presign) throw new Error('presign fixture is not ready');
    return h.presign(...args);
  },
  removeRemote: async (key: string) => { h.removed.push(key); },
}));

import { createBotGroupAttachmentUploadRegistry } from '../botGroupAttachmentUploadRegistry.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('host-issued group attachment upload receipts', () => {
  let server: http.Server;
  let baseUrl = '';
  let httpPresign: typeof h.presign;
  const objects = new Map<string, Buffer>();

  beforeAll(async () => {
    server = http.createServer(async (request, response) => {
      const name = request.url ?? '';
      if (request.method === 'POST' && name === '/presign') {
        h.presignCalls += 1;
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { size: number; ext: string; contentType: string };
        const key = `/objects/${h.presignCalls}.${body.ext}`;
        const responseBody = {
          putUrl: `${baseUrl}${key}`,
          key: `${baseUrl}${key}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(responseBody));
        return;
      }
      if (name.startsWith('/objects/')) {
        if (request.method === 'PUT') {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          objects.set(name, Buffer.concat(chunks));
          response.statusCode = 200;
          response.end();
          return;
        }
        if (request.method === 'GET') {
          const bytes = objects.get(name);
          if (!bytes) { response.statusCode = 404; response.end(); return; }
          response.statusCode = 200;
          response.end(bytes);
          return;
        }
      }
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing upload fixture address');
    baseUrl = `http://127.0.0.1:${address.port}`;
    httpPresign = async (size, ext, contentType) => {
      const response = await fetch(`${baseUrl}/presign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ size, ext, contentType }),
      });
      return await response.json() as { putUrl: string; key: string; expiresAt: string };
    };
    h.presign = httpPresign;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  beforeEach(() => {
    h.presign = httpPresign;
    h.presignCalls = 0;
    h.removed = [];
    objects.clear();
  });

  function context(overrides: Record<string, unknown> = {}) {
    return {
      controllerDeviceId: 'peer-a',
      groupId: 'group-a',
      intent: 'send-intent-1',
      attachmentId: 'attachment-1',
      size: 9,
      sha256: 'a'.repeat(64),
      mimeType: 'image/png',
      ownerToken: 'owner-a',
      client: {},
      linkEpoch: 7,
      groupRevision: 'revision-1',
      ...overrides,
    };
  }

  it('presigns through the local HTTP contract, accepts PUT/GET, and releases only after commit', async () => {
    const registry = createBotGroupAttachmentUploadRegistry({
      presignPut: h.presign!,
      removeRemote: async (key) => { h.removed.push(key); },
    });
    const upload = context();
    const grant = await registry.prepare(upload, 'png');
    const replay = await registry.prepare({ ...upload }, 'png');
    expect(replay).toEqual(grant);
    expect(h.presignCalls).toBe(1);

    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
    await expect(fetch(grant.putUrl, { method: 'PUT', body: bytes })).resolves.toMatchObject({ ok: true });
    const lease = await registry.consume(grant.receipt, upload);
    const downloaded = await fetch(lease.ref.ossKey);
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
    expect(h.removed).toEqual([]);
    await lease.commit();
    expect(h.removed).toEqual([lease.ref.ossKey]);
    await lease.commit();
    expect(h.removed).toHaveLength(1);
  });

  it('serializes concurrent retries of one stable intent and rejects another peer/epoch', async () => {
    const gate = deferred<{ putUrl: string; key: string; expiresAt: string }>();
    h.presign = async () => { h.presignCalls += 1; return gate.promise; };
    const registry = createBotGroupAttachmentUploadRegistry({
      presignPut: h.presign!,
      removeRemote: async (key) => { h.removed.push(key); },
    });
    const upload = context();
    const first = registry.prepare(upload, 'png');
    const second = registry.prepare({ ...upload }, 'png');
    await Promise.resolve();
    expect(h.presignCalls).toBe(1);
    gate.resolve({ putUrl: `${baseUrl}/objects/retry.png`, key: `${baseUrl}/objects/retry.png`, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const [firstGrant, secondGrant] = await Promise.all([first, second]);
    expect(secondGrant).toEqual(firstGrant);
    await expect(registry.consume(firstGrant.receipt, { ...upload, controllerDeviceId: 'peer-b' }))
      .rejects.toThrow('BOT_GROUP_UPLOAD_RECEIPT_BINDING');
    await expect(registry.consume(firstGrant.receipt, { ...upload, linkEpoch: 8 }))
      .rejects.toThrow('BOT_GROUP_UPLOAD_RECEIPT_BINDING');
    await expect(registry.prepare({ ...upload, controllerDeviceId: 'peer-b' }, 'png'))
      .rejects.toThrow('BOT_GROUP_UPLOAD_INTENT_REUSED');
  });

  it('keeps a failed materialisation retryable, while cancel is owner/peer bound', async () => {
    const registry = createBotGroupAttachmentUploadRegistry({
      presignPut: h.presign!,
      removeRemote: async (key) => { h.removed.push(key); },
    });
    const upload = context();
    const grant = await registry.prepare(upload, 'pdf');
    const lease = await registry.consume(grant.receipt, upload);
    await lease.rollback();
    expect(registry.size()).toBe(1);
    await expect(registry.cancel(grant.receipt, { ...upload, ownerToken: 'owner-b' }))
      .rejects.toThrow('BOT_GROUP_UPLOAD_RECEIPT_BINDING');
    await registry.cancel(grant.receipt, upload);
    expect(registry.size()).toBe(0);
    expect(h.removed).toHaveLength(1);
  });

  it('rejects an expired receipt before handing the key to materialisation', async () => {
    let clock = Date.now();
    const registry = createBotGroupAttachmentUploadRegistry({
      presignPut: async () => ({
        putUrl: `${baseUrl}/objects/expired.png`, key: `${baseUrl}/objects/expired.png`,
        expiresAt: new Date(clock + 10).toISOString(),
      }),
      removeRemote: async (key) => { h.removed.push(key); },
      now: () => clock,
      ttlMs: 60_000,
    });
    const upload = context();
    const grant = await registry.prepare(upload, 'png');
    clock += 11;
    await expect(registry.consume(grant.receipt, upload)).rejects.toThrow('BOT_GROUP_UPLOAD_RECEIPT_EXPIRED');
    expect(h.removed).toEqual([`${baseUrl}/objects/expired.png`]);
  });

  it('releases a presigned source when the connection is revoked during presign', async () => {
    const key = `${baseUrl}/objects/revoked.png`;
    let checks = 0;
    const registry = createBotGroupAttachmentUploadRegistry({
      presignPut: async () => ({ putUrl: key, key, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      removeRemote: async (released) => { h.removed.push(released); },
    });
    await expect(registry.prepare(context({
      assertCurrent: () => {
        checks += 1;
        if (checks >= 2) throw new Error('connection revoked');
      },
    }), 'png')).rejects.toThrow('connection revoked');
    expect(registry.size()).toBe(0);
    expect(h.removed).toEqual([key]);
  });

  it('does not let an intent replay change content or weaken the client binding', async () => {
    const registry = createBotGroupAttachmentUploadRegistry({
      presignPut: h.presign!,
      removeRemote: async (key) => { h.removed.push(key); },
    });
    const upload = context({ client: {} });
    const grant = await registry.prepare(upload, 'png');

    for (const changed of [
      { size: 10 },
      { sha256: 'b'.repeat(64) },
      { mimeType: 'application/pdf' },
      { client: undefined },
    ]) {
      await expect(registry.prepare({ ...upload, ...changed }, 'png'))
        .rejects.toThrow('BOT_GROUP_UPLOAD_INTENT_REUSED');
    }
    await expect(registry.prepare(upload, 'jpg'))
      .rejects.toThrow('BOT_GROUP_UPLOAD_INTENT_REUSED');
    await registry.cancel(grant.receipt, upload);
    expect(h.removed).toHaveLength(1);
  });

  it('keeps an expired in-flight source until the original lease settles', async () => {
    let clock = Date.now();
    const key = `${baseUrl}/objects/in-flight.png`;
    const registry = createBotGroupAttachmentUploadRegistry({
      presignPut: async () => ({ putUrl: key, key, expiresAt: new Date(clock + 10_000).toISOString() }),
      removeRemote: async (released) => { h.removed.push(released); },
      now: () => clock,
      ttlMs: 60_000,
    });
    const upload = context();
    const grant = await registry.prepare(upload, 'png');
    const lease = await registry.consume(grant.receipt, upload);
    clock += 10_001;

    // The timer is intentionally not advanced; find() observes the fake clock.
    await expect(registry.consume(grant.receipt, upload))
      .rejects.toThrow('BOT_GROUP_UPLOAD_RECEIPT_EXPIRED');
    await expect(registry.cancel(grant.receipt, { ...upload, controllerDeviceId: 'peer-b' }))
      .rejects.toThrow('BOT_GROUP_UPLOAD_RECEIPT_BINDING');
    await expect(registry.cancel(grant.receipt, upload))
      .rejects.toThrow('BOT_GROUP_UPLOAD_RECEIPT_EXPIRED');
    expect(h.removed).toEqual([]);

    await lease.commit();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.removed).toEqual([key]);
    expect(registry.pendingCleanupSize()).toBe(0);
  });

  it('keeps failed cleanup retryable and never rejects a durable commit', async () => {
    let fail = true;
    const registry = createBotGroupAttachmentUploadRegistry({
      presignPut: h.presign!,
      removeRemote: async (key) => {
        if (fail) throw new Error('relay unavailable');
        h.removed.push(key);
      },
    });
    const upload = context();
    const grant = await registry.prepare(upload, 'png');
    const lease = await registry.consume(grant.receipt, upload);

    await expect(lease.commit()).resolves.toBeUndefined();
    await Promise.resolve();
    expect(registry.size()).toBe(0);
    expect(registry.pendingCleanupSize()).toBe(1);
    expect(h.removed).toEqual([]);

    fail = false;
    await registry.retryPendingCleanup();
    expect(registry.pendingCleanupSize()).toBe(0);
    expect(h.removed).toEqual([lease.ref.ossKey]);
  });

  it('retries an expired prepared cancellation without restoring the grant', async () => {
    let clock = Date.now();
    let fail = true;
    const key = `${baseUrl}/objects/cancel-retry.png`;
    const registry = createBotGroupAttachmentUploadRegistry({
      presignPut: async () => ({ putUrl: key, key, expiresAt: new Date(clock + 10).toISOString() }),
      removeRemote: async (released) => {
        if (fail) throw new Error('relay unavailable');
        h.removed.push(released);
      },
      now: () => clock,
      ttlMs: 60_000,
    });
    const upload = context();
    const grant = await registry.prepare(upload, 'png');
    clock += 11;
    await expect(registry.cancel(grant.receipt, upload)).rejects.toThrow('relay unavailable');
    expect(registry.size()).toBe(1);
    fail = false;
    await expect(registry.cancel(grant.receipt, upload)).resolves.toBeUndefined();
    expect(registry.size()).toBe(0);
    expect(h.removed).toEqual([key]);
    await expect(registry.consume(grant.receipt, upload)).rejects.toThrow('BOT_GROUP_UPLOAD_RECEIPT_EXPIRED');
  });
});
