import type { Readable, Writable } from 'node:stream';
import { OmpJsonlReader, OMP_MAX_FRAME_BYTES } from './jsonl-reader.js';
import type { OmpRpcTransport } from './rpc-client.js';

export interface OmpStreamTransport extends OmpRpcTransport {
  close(): void;
  isClosed(): boolean;
  beginDrain(): void;
}

export function createOmpStreamTransport(
  input: Writable,
  output: Readable,
  onTerminate: () => void,
): OmpStreamTransport {
  if (input.writableObjectMode || output.readableObjectMode) {
    throw new Error('OMP transport requires dedicated byte streams');
  }
  if (input.writableLength !== 0) {
    throw new Error('OMP transport requires an empty dedicated input stream');
  }
  let closed = false;
  let started = false;
  let draining = false;
  const lines = new Set<(line: string) => void>();
  const closes = new Set<() => void>();
  const reader = new OmpJsonlReader(
    (line) => {
      for (const listener of lines) {
        if (closed) break;
        listener(line);
      }
    },
    () => close(),
  );
  const attempt = (callback: () => void): void => {
    try {
      callback();
    } catch {
      return;
    }
  };
  function close(): void {
    if (closed) return;
    closed = true;
    reader.stop();
    attempt(() => output.off('data', onData));
    attempt(() => output.off('end', onEnd));
    attempt(() => output.off('close', close));
    attempt(() => input.off('close', onInputClose));
    attempt(() => output.pause());
    lines.clear();
    const notifications = Array.from(closes);
    closes.clear();
    for (const callback of notifications) attempt(callback);
    attempt(onTerminate);
  }
  const onData = (chunk: unknown): void => {
    if (!(chunk instanceof Uint8Array)) {
      close();
      return;
    }
    reader.push(chunk);
  };
  const onEnd = (): void => {
    reader.end();
    close();
  };
  const onInputClose = (): void => {
    if (!draining) close();
  };
  output.pause();
  output.on('error', close);
  input.on('error', onInputClose);
  output.on('close', close);
  input.on('close', onInputClose);
  output.on('end', onEnd);

  return {
    close,
    isClosed: () => closed,
    beginDrain: () => {
      draining = true;
    },
    onLine(listener) {
      if (closed) return () => undefined;
      lines.add(listener);
      if (!started) {
        started = true;
        output.on('data', onData);
        output.resume();
      }
      return () => {
        lines.delete(listener);
      };
    },
    onClose(listener) {
      if (closed) {
        attempt(listener);
        return () => undefined;
      }
      closes.add(listener);
      return () => {
        closes.delete(listener);
      };
    },
    writeLine(line) {
      if (closed || draining || input.destroyed || !input.writable)
        throw new Error('OMP transport is closed');
      if (
        typeof line !== 'string' ||
        line.includes('\n') ||
        line.includes('\r')
      ) {
        throw new Error('Invalid OMP transport frame');
      }
      const size = Buffer.byteLength(line, 'utf8');
      if (size > OMP_MAX_FRAME_BYTES)
        throw new Error('OMP transport frame exceeds limit');
      if (input.writableLength + size + 1 > OMP_MAX_FRAME_BYTES + 1) {
        close();
        throw new Error(
          'OMP transport backpressure limit reached; execution outcome is unknown',
        );
      }
      try {
        input.write(Buffer.from(line + '\n', 'utf8'), (error) => {
          if (error) onInputClose();
        });
      } catch {
        close();
        throw new Error(
          'OMP transport write failed; execution outcome is unknown',
        );
      }
    },
  };
}
