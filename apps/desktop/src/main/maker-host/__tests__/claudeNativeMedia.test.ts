import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  owner: { dataOwnerId: 'owner', generation: 1 }, pending: false, current: true,
  db: {}, snapshot: null as null | { client: { drizzle: object } },
  ingest: vi.fn(), hasRef: vi.fn(),
}));
vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => state.owner, isAppSessionBoundaryPending: () => state.pending,
}));
vi.mock('../../localDb/client/current.js', () => ({ getCurrentDbClientSnapshot: () => state.snapshot }));
vi.mock('../../cindy-media/refCompensationJournal.js', () => ({ captureMediaRefCompensationScope: () => ({}) }));
vi.mock('../../cindy-media/ingest.js', () => ({ ingestMedia: state.ingest }));
vi.mock('../../cindy-media/ledger.js', async original => ({
  ...await original<typeof import('../../cindy-media/ledger.js')>(), hasRef: state.hasRef,
}));
vi.mock('../../cindy-media/blobStore.js', () => ({
  resolveSafe: () => ({ absPath: path.resolve('owned-store', 'image.png'), mimeType: 'image/png' }),
}));
import { createClaudeNativeMediaImporter } from '../claudeNativeMedia.js';
import { createPiNativeMediaImporter } from '../piNativeMedia.js';

const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const url = `cindy-media://blobs/${'a'.repeat(64)}.png`;
const source = () => ({ type: 'base64', media_type: 'image/png', data });
const request = (block: unknown = { type: 'image', source: source() }) => ({
  sessionId: 'native', messageId: 'row', index: 0, block, signal: new AbortController().signal,
});
function importer(task = 'task') {
  return createClaudeNativeMediaImporter({ sessionId: task, nativeSessionId: 'native', isCurrent: () => state.current });
}
beforeEach(() => {
  state.owner = { dataOwnerId: 'owner', generation: 1 }; state.pending = false; state.current = true;
  state.snapshot = { client: { drizzle: state.db } };
  state.ingest.mockReset().mockResolvedValue({ url }); state.hasRef.mockReset().mockResolvedValue(false);
});

describe('Claude native image ownership', () => {
  it('decodes original Pi image framing through the same task-owned media boundary', async () => {
    const load = createPiNativeMediaImporter({ sessionId: 'pi-task', nativeSessionId: 'native', isCurrent: () => state.current });
    expect(await load(request({ type: 'image', data, mimeType: 'image/png' }))).toMatchObject({ managedUrl: url, pathOrigin: 'desktop-host' });
    expect(state.ingest).toHaveBeenCalledWith(expect.objectContaining({ refs: [{ refKind: 'session-attachment', refId: 'pi-task', originSessionId: 'pi-task', originKind: 'user' }] }), state.db);
    await expect(load(request({ type: 'image', path: '/untrusted/image.png' }))).rejects.toThrow('supported image bytes');
    await expect(load(request({ type: 'image', data, mimeType: 'image/jpeg' }))).rejects.toThrow('does not match');
    state.current = false;
    await expect(load(request({ type: 'image', data, mimeType: 'image/png' }))).rejects.toThrow('task changed');
    expect(state.ingest).toHaveBeenCalledOnce();
  });
  it('pins exact native bytes before returning a managed URL and host-only path', async () => {
    expect(await importer()(request())).toEqual({ type: 'image', path: path.resolve('owned-store', 'image.png'),
      managedUrl: url, mimeType: 'image/png', pathOrigin: 'desktop-host' });
    expect(state.ingest).toHaveBeenCalledWith(expect.objectContaining({
      buffer: Buffer.from(data, 'base64'), mimeType: 'image/png', isCache: false,
      refs: [{ refKind: 'session-attachment', refId: 'task', originSessionId: 'task', originKind: 'user' }],
      assertStillValid: expect.any(Function), refCompensationScope: expect.any(Object),
    }), state.db);
  });

  it.each([
    { type: 'image', source: { type: 'url', url: 'https://example.test/image.png' } },
    { type: 'image', source: { type: 'file', path: '/remote/private/image.png' } },
    { type: 'document', source: { type: 'base64', data: 'JVBERg==', media_type: 'application/pdf' } },
    { type: 'image', source: { ...source(), data: 'text' } },
    { type: 'image', source: { ...source(), data: data + '\n' } },
    { type: 'image', source: { ...source(), media_type: 'image/jpeg' } },
  ])('refuses unsupported or disguised sources without filesystem/network fallback: %j', async block => {
    await expect(importer()(request(block))).rejects.toThrow();
    expect(state.ingest).not.toHaveBeenCalled();
  });

  it.each(['owner', 'generation', 'database', 'pending', 'session', 'abort', 'runtime'] as const)(
    'fences a captured importer on %s change', async change => {
      const load = importer(), input = request();
      if (change === 'owner') state.owner.dataOwnerId = 'other';
      if (change === 'generation') state.owner.generation++;
      if (change === 'database') state.snapshot = { client: { drizzle: {} } };
      if (change === 'pending') state.pending = true;
      if (change === 'session') input.sessionId = 'other-native';
      if (change === 'runtime') state.current = false;
      if (change === 'abort') input.signal = AbortSignal.abort();
      await expect(load(input)).rejects.toThrow('task changed');
      expect(state.ingest).not.toHaveBeenCalled();
    },
  );

  it('guards awaited reference lookup and the ingestion compensation boundary', async () => {
    state.hasRef.mockImplementationOnce(async () => { state.owner.generation++; return false; });
    await expect(importer()(request())).rejects.toThrow('task changed');
    expect(state.ingest).not.toHaveBeenCalled();
    state.ingest.mockImplementationOnce(async params => {
      params.assertStillValid(); state.pending = true; params.assertStillValid(); return { url };
    });
    await expect(importer()(request())).rejects.toThrow('task changed');
  });

  it('serializes duplicate image publication and keeps task references separate', async () => {
    const pinned = new Set<string>();
    state.hasRef.mockImplementation(async ({ refId }) => pinned.has(refId));
    state.ingest.mockImplementation(async params => {
      await Promise.resolve();
      for (const ref of params.refs) pinned.add(ref.refId);
      return { url };
    });
    const load = importer();
    await Promise.all([load(request()), load(request()), importer('second')(request())]);
    expect(state.ingest.mock.calls.flatMap(([params]) => params.refs).map(ref => ref.refId).sort()).toEqual(['second', 'task']);
  });

  it('does not report success after a failed ingest, and a later attempt can complete', async () => {
    const load = importer(); state.ingest.mockRejectedValueOnce(new Error('reference failed'));
    await expect(load(request())).rejects.toThrow('reference failed');
    await expect(load(request())).resolves.toMatchObject({ managedUrl: url });
    expect(state.ingest.mock.calls[1][0].refs).toHaveLength(1);
  });
});
