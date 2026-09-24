import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ net: { fetch: fetchMock } }));

import { downloadVerifiedPlugin } from '../download';

const files: string[] = [];

afterEach(() => {
  fetchMock.mockReset();
  vi.useRealTimers();
  for (const file of files.splice(0)) fs.rmSync(file, { force: true });
});
function target(): string {
  const file = path.join(
    os.tmpdir(),
    `cindy-plugin-download-${process.pid}-${Date.now()}-${Math.random()}.cindy`,
  );
  files.push(file);
  return file;
}

function expected(bytes: Buffer) {
  return {
    sizeBytes: bytes.byteLength,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

describe('downloadVerifiedPlugin', () => {
  it('writes only bytes matching the release size and SHA-256', async () => {
    const bytes = Buffer.from('verified plugin bytes');
    fetchMock.mockResolvedValue(
      new Response(bytes, {
        status: 200,
        headers: { 'content-length': String(bytes.byteLength) },
      }),
    );
    const file = target();

    await downloadVerifiedPlugin('https://downloads.example.test/a', expected(bytes), file);

    expect(fs.readFileSync(file)).toEqual(bytes);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://downloads.example.test/a',
      expect.objectContaining({
        redirect: 'error',
        cache: 'no-store',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('rejects a SHA mismatch without writing the target', async () => {
    const bytes = Buffer.from('tampered');
    fetchMock.mockResolvedValue(new Response(bytes, { status: 200 }));
    const file = target();

    await expect(
      downloadVerifiedPlugin('https://downloads.example.test/a', {
        ...expected(bytes),
        sha256: '0'.repeat(64),
      }, file),
    ).rejects.toThrow('SHA-256');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('stops when the stream exceeds the declared release size', async () => {
    const bytes = Buffer.from('larger-than-declared');
    fetchMock.mockResolvedValue(new Response(bytes, { status: 200 }));
    const file = target();

    await expect(
      downloadVerifiedPlugin(
        'https://downloads.example.test/a',
        { sizeBytes: 3, sha256: '0'.repeat(64) },
        file,
      ),
    ).rejects.toMatchObject({ code: 'GHOST_FILE_INVALID' });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('rejects unsafe or over-limit release sizes before fetching', async () => {
    const file = target();
    await expect(
      downloadVerifiedPlugin('https://downloads.example.test/a', { sizeBytes: 1.5, sha256: '0'.repeat(64) }, file),
    ).rejects.toMatchObject({ code: 'GHOST_FILE_INVALID' });
    await expect(
      downloadVerifiedPlugin('https://downloads.example.test/a', { sizeBytes: 128 * 1024 * 1024 + 1, sha256: '0'.repeat(64) }, file),
    ).rejects.toMatchObject({ code: 'GHOST_FILE_INVALID' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('maps a stalled request to a stable timeout code', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url: string, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const pending = downloadVerifiedPlugin(
      'https://downloads.example.test/a',
      { sizeBytes: 1, sha256: '0'.repeat(64) },
      target(),
    );
    const rejection = expect(pending).rejects.toMatchObject({ code: 'GHOST_DOWNLOAD_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
    vi.useRealTimers();
  });

  it('cancels the response body when Content-Length mismatches the release', async () => {
    const bytes = Buffer.from('mismatched length');
    const response = new Response(bytes, {
      status: 200,
      headers: { 'content-length': String(bytes.byteLength + 1) },
    });
    const cancel = vi.spyOn(response.body!, 'cancel');
    fetchMock.mockResolvedValue(response);

    await expect(
      downloadVerifiedPlugin(
        'https://downloads.example.test/a',
        expected(bytes),
        target(),
      ),
    ).rejects.toThrow('Content-Length');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('waits for body cancellation before closing and removing a partial download', async () => {
    const bytes = Buffer.from('too large');
    let markCancelStarted!: () => void;
    let finishCancel!: () => void;
    const cancelStarted = new Promise<void>((resolve) => { markCancelStarted = resolve; });
    const cancellation = new Promise<void>((resolve) => { finishCancel = resolve; });
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes); },
      cancel() {
        markCancelStarted();
        return cancellation;
      },
    });
    fetchMock.mockResolvedValue(new Response(body, { status: 200 }));
    const file = target();
    const pending = downloadVerifiedPlugin('https://downloads.example.test/a', {
      sizeBytes: 1,
      sha256: expected(Buffer.from('x')).sha256,
    }, file);

    await cancelStarted;
    expect(fs.existsSync(file)).toBe(true);
    finishCancel();
    await expect(pending).rejects.toMatchObject({ code: 'GHOST_FILE_INVALID' });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('bounds a response cancellation that never settles', async () => {
    vi.useFakeTimers();
    let markCancelStarted!: () => void;
    const cancelStarted = new Promise<void>((resolve) => { markCancelStarted = resolve; });
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from('too large')); },
      cancel() {
        markCancelStarted();
        return new Promise<void>(() => undefined);
      },
    });
    fetchMock.mockResolvedValue(new Response(body, { status: 200 }));
    const file = target();
    const pending = downloadVerifiedPlugin('https://downloads.example.test/a', {
      sizeBytes: 1,
      sha256: expected(Buffer.from('x')).sha256,
    }, file);
    const rejection = expect(pending).rejects.toMatchObject({ code: 'GHOST_FILE_INVALID' });

    await cancelStarted;
    expect(fs.existsSync(file)).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    await rejection;
    expect(fs.existsSync(file)).toBe(false);
  });
});
