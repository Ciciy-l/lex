import { TextDecoder } from 'node:util';

export const OMP_MAX_FRAME_BYTES = 1024 * 1024;

export type OmpReadFailure =
  'frame-limit' | 'invalid-utf8' | 'truncated-frame' | 'consumer-failed';

export class OmpJsonlReader {
  private buffer = Buffer.alloc(0);
  private length = 0;
  private stopped = false;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly onFailure: (reason: OmpReadFailure) => void,
  ) {}

  push(chunk: Uint8Array): void {
    if (this.stopped) return;
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let start = 0;
    while (start < bytes.length && !this.stopped) {
      const newline = bytes.indexOf(10, start);
      const end = newline === -1 ? bytes.length : newline;
      const size = end - start;
      if (this.length + size > OMP_MAX_FRAME_BYTES + 1) {
        this.fail('frame-limit');
        return;
      }
      if (this.length + size > 0) {
        if (this.buffer.length === 0)
          this.buffer = Buffer.allocUnsafe(OMP_MAX_FRAME_BYTES + 1);
        bytes.copy(this.buffer, this.length, start, end);
        this.length += size;
      }
      if (
        this.length > OMP_MAX_FRAME_BYTES &&
        this.buffer[this.length - 1] !== 13
      ) {
        this.fail('frame-limit');
        return;
      }
      if (newline === -1) return;
      const contentLength =
        this.length > 0 && this.buffer[this.length - 1] === 13
          ? this.length - 1
          : this.length;
      let line: string;
      try {
        line = new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: true,
        }).decode(this.buffer.subarray(0, contentLength));
      } catch {
        this.fail('invalid-utf8');
        return;
      }
      this.length = 0;
      try {
        this.onLine(line);
      } catch {
        this.fail('consumer-failed');
        return;
      }
      start = newline + 1;
    }
  }

  end(): void {
    if (this.stopped) return;
    if (this.length > 0) this.fail('truncated-frame');
    else this.stop();
  }

  stop(): void {
    this.stopped = true;
    this.length = 0;
    this.buffer = Buffer.alloc(0);
  }

  private fail(reason: OmpReadFailure): void {
    this.stop();
    try {
      this.onFailure(reason);
    } catch {
      return;
    }
  }
}
