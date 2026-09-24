import crypto from 'node:crypto';
import fs from 'node:fs';

import { PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES } from '@cindy/plugin-protocol';
import { net } from 'electron';

import { createIpcError } from '../../shared/ipc-errors.js';

const PLUGIN_DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
const PLUGIN_DOWNLOAD_TOTAL_TIMEOUT_MS = 120_000;
const PLUGIN_STREAM_CANCEL_TIMEOUT_MS = 250;

async function cancelWithinDeadline(cancel: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(cancel).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, PLUGIN_STREAM_CANCEL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function downloadVerifiedPlugin(
  url: string,
  expected: { sizeBytes: number; sha256: string },
  targetPath: string,
): Promise<void> {
  if (!Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes <= 0) {
    throw createIpcError('GHOST_FILE_INVALID', 'Plugin Release size is invalid');
  }
  if (expected.sizeBytes > PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES) {
    throw createIpcError('GHOST_FILE_INVALID', 'Plugin archive exceeds 128 MiB');
  }

  const controller = new AbortController();
  const totalTimer = setTimeout(() => controller.abort(), PLUGIN_DOWNLOAD_TOTAL_TIMEOUT_MS);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), PLUGIN_DOWNLOAD_IDLE_TIMEOUT_MS);
  };
  const network = async <T>(operation: Promise<T>): Promise<T> => {
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(new Error('Plugin download aborted'));
      if (controller.signal.aborted) abortListener();
      else controller.signal.addEventListener('abort', abortListener, { once: true });
    });
    try {
      return await Promise.race([operation, aborted]);
    } catch {
      throw createIpcError(
        controller.signal.aborted ? 'GHOST_DOWNLOAD_TIMEOUT' : 'GHOST_DOWNLOAD_FAILED',
        controller.signal.aborted ? 'Plugin download timed out' : 'Plugin download failed',
      );
    } finally {
      if (abortListener) controller.signal.removeEventListener('abort', abortListener);
    }
  };

  resetIdleTimer();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let file: fs.promises.FileHandle | undefined;
  let complete = false;
  try {
    const response = await network(net.fetch(url, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    }));
    if (!response.ok) {
      if (response.body) await cancelWithinDeadline(() => response.body!.cancel());
      throw createIpcError('GHOST_DOWNLOAD_FAILED', 'Plugin download failed');
    }
    if (!response.body) {
      throw createIpcError('GHOST_DOWNLOAD_FAILED', 'Plugin response body is empty');
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && Number(contentLength) !== expected.sizeBytes) {
      await cancelWithinDeadline(() => response.body!.cancel());
      throw createIpcError('GHOST_FILE_INVALID', 'Plugin download Content-Length mismatch');
    }

    reader = response.body.getReader();
    resetIdleTimer();
    file = await fs.promises.open(targetPath, 'wx', 0o600);
    const hash = crypto.createHash('sha256');
    let size = 0;
    while (true) {
      if (controller.signal.aborted) {
        throw createIpcError('GHOST_DOWNLOAD_TIMEOUT', 'Plugin download timed out');
      }
      const { done, value } = await network(reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > expected.sizeBytes) {
        throw createIpcError('GHOST_FILE_INVALID', 'Plugin download exceeds Release size');
      }
      if (value.byteLength > 0) {
        resetIdleTimer();
        hash.update(value);
        await file.writeFile(value);
      }
    }
    if (controller.signal.aborted) {
      throw createIpcError('GHOST_DOWNLOAD_TIMEOUT', 'Plugin download timed out');
    }
    if (size !== expected.sizeBytes) {
      throw createIpcError('GHOST_FILE_INVALID', 'Plugin download size mismatch');
    }
    if (hash.digest('hex') !== expected.sha256) {
      throw createIpcError('GHOST_FILE_INVALID', 'Plugin download SHA-256 mismatch');
    }
    await file.close();
    complete = true;
  } finally {
    clearTimeout(totalTimer);
    clearTimeout(idleTimer);
    if (reader) {
      await cancelWithinDeadline(() => reader!.cancel());
      try { reader.releaseLock(); } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
    }
    if (file && !complete) {
      await file.close().catch(() => undefined);
      await fs.promises.rm(targetPath, { force: true });
    }
  }
}
