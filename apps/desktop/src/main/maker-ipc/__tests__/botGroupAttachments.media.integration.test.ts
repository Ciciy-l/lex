import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAttachmentOssRef, parseAttachmentOssRef } from '@cindy/device-link';

const h = vi.hoisted(() => ({
  db: null as any,
  requests: 0,
  removed: [] as string[],
  revoke: null as (() => void) | null,
  presignCalls: 0,
}));

let userData = '';
let baseUrlForTests = '';
vi.mock('electron', () => ({ app: { getPath: () => userData } }));
vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({ drizzle: h.db }),
}));
vi.mock('../../device-link/mediaTransfer.js', () => ({
  removeRemote: vi.fn(async (key: string) => { h.removed.push(key); }),
  presignPutForRemoteAttachment: vi.fn(async (size: number, ext: string, contentType: string) => {
    const response = await fetch(`${baseUrlForTests}/presign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ size, ext, contentType }),
    });
    return await response.json();
  }),
}));
vi.mock('../../device-link/remoteAttachment.js', () => ({
  parseRemoteAttachmentRef: (value: string) => parseAttachmentOssRef(value),
  materializeRemoteAttachment: async (
    ref: { ossKey: string; size?: number; sha256?: string },
    destination: string,
  ) => {
    h.requests += 1;
    const response = await fetch(ref.ossKey);
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (ref.size !== bytes.byteLength || ref.sha256 !== digest) throw new Error('FILE_PEER_INTEGRITY');
    await fsp.writeFile(destination, bytes, { flag: 'wx' });
    h.revoke?.();
  },
}));

const schema = await import('../../localDb/schema.js');
const { createBotGroupAttachmentStore } = await import('../botGroupAttachments.js');
const { createBotGroupAttachmentUploadRegistry } = await import('../botGroupAttachmentUploadRegistry.js');

const MIGRATION_0070 = path.resolve(__dirname, '../../../../drizzle/0070_woozy_harpoon.sql');
const { default: migration0071 } = (await import('../../../../drizzle/scripts/0071_bright_ultron')) as {
  default: { run: (db: Database.Database) => void };
};

function freshDb(): any {
  const raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  for (const statement of fs.readFileSync(MIGRATION_0070, 'utf8').split('--> statement-breakpoint')) {
    if (statement.trim()) raw.exec(statement);
  }
  migration0071.run(raw);
  return drizzle(raw, { schema });
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function mp4Bytes(): Buffer {
  const bytes = Buffer.alloc(24);
  bytes.writeUInt32BE(24, 0);
  bytes.write('ftyp', 4, 'ascii');
  bytes.write('isom', 8, 'ascii');
  bytes.writeUInt32BE(0, 12);
  bytes.write('mp42', 16, 'ascii');
  bytes.write('isom', 20, 'ascii');
  return bytes;
}

function wavBytes(): Buffer {
  const bytes = Buffer.alloc(44);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(36, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8_000, 24);
  bytes.writeUInt32LE(16_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(0, 40);
  return bytes;
}

function refFor(base: string, bytes: Buffer, mimeType: string, originalName: string): string {
  return buildAttachmentOssRef({
    ossKey: `${base}/${originalName}`,
    mimeType,
    originalName,
    size: bytes.byteLength,
    sha256: digest(bytes),
  });
}

describe('bot group attachment real ledger/media boundary', () => {
  let server: http.Server;
  let baseUrl = '';
  const files = new Map<string, Buffer>();

  beforeAll(async () => {
    userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'bot-group-media-integration-'));
    server = http.createServer(async (request, response) => {
      const requestPath = request.url ?? '';
      if (request.method === 'POST' && requestPath === '/presign') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { ext: string; size: number; contentType: string };
        h.presignCalls += 1;
        const keyPath = `/objects/${h.presignCalls}.${body.ext}`;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          putUrl: `${baseUrlForTests}${keyPath}`,
          key: `${baseUrlForTests}${keyPath}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }));
        return;
      }
      if (request.method === 'PUT' && requestPath.startsWith('/objects/')) {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        files.set(requestPath, Buffer.concat(chunks));
        response.statusCode = 200;
        response.end();
        return;
      }
      const bytes = files.get(requestPath);
      if (!bytes) { response.statusCode = 404; response.end(); return; }
      response.statusCode = 200;
      response.end(bytes);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
    baseUrlForTests = baseUrl;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fsp.rm(userData, { recursive: true, force: true });
  });

  beforeEach(async () => {
    h.db = freshDb();
    h.requests = 0;
    h.removed = [];
    h.revoke = null;
    h.presignCalls = 0;
    files.clear();
    await fsp.mkdir(path.join(userData, 'owner'), { recursive: true });
  });

  function store(allowedPeer = 'peer-a') {
    return createBotGroupAttachmentStore({
      ownerRoot: () => path.join(userData, 'owner'),
      verifyRemoteAttachment: async (_ref, context) => context.controllerDeviceId === allowedPeer,
    });
  }

  it('uses a real SQLite ledger and local HTTP bytes; media sniff routes video/audio to cindy-media', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
    const mp4 = mp4Bytes();
    const wav = wavBytes();
    files.set('/photo.png', png);
    files.set('/clip.mp4', mp4);
    files.set('/voice.wav', wav);
    const prepared = await store().prepare({
      groupId: 'group-a',
      controllerDeviceId: 'peer-a',
      attachments: [
        { id: 'p', name: 'photo.png', path: refFor(baseUrl, png, 'image/png', 'photo.png'), category: 'image', mimeType: 'image/png' },
        { id: 'v', name: 'clip.mp4', path: refFor(baseUrl, mp4, 'video/mp4', 'clip.mp4'), category: 'file', mimeType: 'video/mp4' },
        { id: 'a', name: 'voice.wav', path: refFor(baseUrl, wav, 'audio/wav', 'voice.wav'), category: 'file', mimeType: 'audio/wav' },
      ],
    });
    expect(prepared).toMatchObject({ ok: true });
    if (!prepared.ok) throw new Error(prepared.message);
    expect(prepared.attachments.map((item) => item.url?.startsWith('cindy-media://'))).toEqual([true, true, true]);
    expect(h.db.select().from(schema.mediaRefs).all()).toHaveLength(3);
    await prepared.discard();
    expect(h.db.select().from(schema.mediaRefs).all()).toHaveLength(0);
    expect(h.removed).toEqual([]);
  });

  it('rejects a second peer before download and rejects real digest/size mismatch', async () => {
    const bytes = Buffer.from('private upload');
    files.set('/private.txt', bytes);
    const valid = refFor(baseUrl, bytes, 'text/plain', 'private.txt');
    await expect(store().prepare({
      groupId: 'group-a', controllerDeviceId: 'peer-b',
      attachments: [{ id: 'b', name: 'private.txt', path: valid, category: 'text', mimeType: 'text/plain' }],
    })).resolves.toMatchObject({ ok: false });
    expect(h.requests).toBe(0);

    const bad = buildAttachmentOssRef({
      ossKey: `${baseUrl}/private.txt`, mimeType: 'text/plain', originalName: 'private.txt',
      size: bytes.byteLength + 1, sha256: '0'.repeat(64),
    });
    await expect(store().prepare({
      groupId: 'group-a', controllerDeviceId: 'peer-a',
      attachments: [{ id: 'bad', name: 'private.txt', path: bad, category: 'text', mimeType: 'text/plain' }],
    })).resolves.toMatchObject({ ok: false });
    expect(h.db.select().from(schema.mediaRefs).all()).toHaveLength(0);
  });

  it('keeps each same-blob batch ref independent and rejects dangerous/path-like names', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    files.set('/same.png', png);
    const ref = refFor(baseUrl, png, 'image/png', 'same.png');
    const first = await store().prepare({
      groupId: 'group-a', controllerDeviceId: 'peer-a',
      attachments: [{ id: '1', name: 'same.png', path: ref, category: 'image', mimeType: 'image/png' }],
    });
    const second = await store().prepare({
      groupId: 'group-a', controllerDeviceId: 'peer-a',
      attachments: [{ id: '2', name: 'same.png', path: ref, category: 'image', mimeType: 'image/png' }],
    });
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    expect(h.db.select().from(schema.mediaRefs).all()).toHaveLength(2);
    if (first.ok) await first.discard();
    expect(h.db.select().from(schema.mediaRefs).all()).toHaveLength(1);
    if (second.ok) await second.discard();
    const dangerous = await store().prepare({
      groupId: 'group-a', controllerDeviceId: 'peer-a',
      attachments: [{ id: 'x', name: 'run.exe', path: ref, category: 'file', mimeType: 'application/octet-stream' }],
    });
    expect(dangerous).toMatchObject({ ok: false });
  });

  it('rechecks the captured operation after download before any rename/write is retained', async () => {
    const bytes = Buffer.from('plain source');
    files.set('/source.txt', bytes);
    const ref = refFor(baseUrl, bytes, 'text/plain', 'source.txt');
    let revoked = false;
    h.revoke = () => { revoked = true; };
    const result = await store().prepare({
      groupId: 'group-a', controllerDeviceId: 'peer-a',
      operationGuard: () => { if (revoked) throw new Error('REMOTE_REVOKED'); },
      attachments: [{ id: 'r', name: 'source.txt', path: ref, category: 'text', mimeType: 'text/plain' }],
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'INVALID_PARAMS' });
    expect(h.db.select().from(schema.mediaRefs).all()).toHaveLength(0);
    expect(h.removed).toEqual([]);
  });

  it('runs host receipt → local HTTP PUT/GET → real SQLite media ledger, preserving retry sources', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
    const sha256 = digest(bytes);
    const client = {};
    const uploadContext = {
      controllerDeviceId: 'peer-a', groupId: 'group-a', intent: 'stable-send-1', attachmentId: 'image-1',
      size: bytes.length, sha256, mimeType: 'image/png', ownerToken: 'owner-a', client, linkEpoch: 3, groupRevision: 'r1',
    };
    const uploads = createBotGroupAttachmentUploadRegistry();
    const attachment = {
      id: uploadContext.attachmentId, name: 'photo.png', path: '', category: 'image' as const, mimeType: uploadContext.mimeType,
      size: bytes.length, sha256, uploadReceipt: '', uploadIntent: uploadContext.intent,
    };
    const scopedStore = () => createBotGroupAttachmentStore({
      ownerRoot: () => path.join(userData, 'owner'),
      attachmentUploads: uploads,
      captureCompensationScope: () => ({
        journalDir: path.join(userData, 'ref-journal'), ownerStorageKey: 'a'.repeat(20), assertStillValid: () => undefined,
      }),
    });

    const grant = await uploads.prepare(uploadContext, 'png');
    attachment.uploadReceipt = grant.receipt;
    const wrongPeer = await scopedStore().prepare({
      groupId: 'group-a', controllerDeviceId: 'peer-b', remoteContext: { ownerToken: 'owner-a', client, linkEpoch: 3, groupRevision: 'r1' },
      attachments: [attachment],
    });
    expect(wrongPeer).toMatchObject({ ok: false });
    expect(h.requests).toBe(0);

    const first = await scopedStore().prepare({
      groupId: 'group-a', controllerDeviceId: 'peer-a', operationGuard: () => undefined,
      remoteContext: { ownerToken: 'owner-a', client, linkEpoch: 3, groupRevision: 'r1' }, attachments: [attachment],
    });
    expect(first).toMatchObject({ ok: false });
    expect(uploads.size()).toBe(1);

    await expect(fetch(grant.putUrl, { method: 'PUT', body: bytes })).resolves.toMatchObject({ ok: true });
    const retried = await scopedStore().prepare({
      groupId: 'group-a', controllerDeviceId: 'peer-a', operationGuard: () => undefined,
      remoteContext: { ownerToken: 'owner-a', client, linkEpoch: 3, groupRevision: 'r1' }, attachments: [attachment],
    });
    expect(retried).toMatchObject({ ok: true });
    if (!retried.ok) throw new Error(retried.message);
    expect(retried.attachments[0]?.url).toContain('cindy-media://blobs/');
    expect(h.db.select().from(schema.mediaRefs).all()).toHaveLength(1);
    await retried.commit();
    expect(h.removed).toEqual([`${baseUrl}/objects/1.png`]);
  });
});
