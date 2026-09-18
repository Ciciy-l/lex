import { describe, expect, it, vi } from 'vitest';
import { OmpJsonlReader, OMP_MAX_FRAME_BYTES } from './jsonl-reader.js';

function fixture() {
  const line = vi.fn();
  const failure = vi.fn();
  const reader = new OmpJsonlReader(line, failure);
  return { reader, line, failure };
}

describe('bounded OMP JSONL byte reader', () => {
  it('preserves UTF-8 at every possible byte boundary and both newline forms', () => {
    const bytes = Buffer.from('{"text":"你好🤖"}\r\n{"type":"ready"}\n');
    for (let split = 0; split <= bytes.length; split++) {
      const test = fixture();
      test.reader.push(bytes.subarray(0, split));
      test.reader.push(bytes.subarray(split));
      test.reader.end();
      expect(test.line.mock.calls.flat()).toEqual([
        '{"text":"你好🤖"}',
        '{"type":"ready"}',
      ]);
      expect(test.failure).not.toHaveBeenCalled();
    }
  });

  it('accepts exactly the frame byte budget plus a split CRLF', () => {
    const test = fixture();
    test.reader.push(Buffer.alloc(OMP_MAX_FRAME_BYTES, 97));
    test.reader.push(Buffer.from('\r'));
    test.reader.push(Buffer.from('\n'));
    expect(test.line).toHaveBeenCalledWith('a'.repeat(OMP_MAX_FRAME_BYTES));
    expect(test.failure).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'fails oversized unterminated lines once (fragmented=%s)',
    (fragmented) => {
      const test = fixture();
      if (fragmented) {
        test.reader.push(Buffer.alloc(OMP_MAX_FRAME_BYTES, 97));
        test.reader.push(Buffer.from('x'));
      } else test.reader.push(Buffer.alloc(OMP_MAX_FRAME_BYTES + 2, 97));
      test.reader.push(Buffer.from('\n{"type":"ready"}\n'));
      test.reader.end();
      expect(test.failure).toHaveBeenCalledExactlyOnceWith('frame-limit');
      expect(test.line).not.toHaveBeenCalled();
    },
  );

  it('does not apply a single-line budget to an entire multi-line chunk', () => {
    const test = fixture();
    const frame = 'a'.repeat(OMP_MAX_FRAME_BYTES) + '\n';
    test.reader.push(Buffer.from(frame + frame));
    expect(test.line).toHaveBeenCalledTimes(2);
    expect(test.failure).not.toHaveBeenCalled();
  });

  it.each([
    [0xc3, 10],
    [0xff, 10],
    [0xed, 0xa0, 0x80, 10],
  ])('rejects invalid UTF-8 without replacement characters: %j', (...bytes) => {
    const test = fixture();
    test.reader.push(Uint8Array.from(bytes));
    expect(test.failure).toHaveBeenCalledExactlyOnceWith('invalid-utf8');
    expect(test.line).not.toHaveBeenCalled();
  });

  it('does not execute an unterminated frame at EOF', () => {
    const test = fixture();
    test.reader.push(Buffer.from('{"type":"ready"}'));
    test.reader.end();
    expect(test.failure).toHaveBeenCalledExactlyOnceWith('truncated-frame');
    expect(test.line).not.toHaveBeenCalled();
  });

  it('respects nonzero typed-array offsets and does not retain mutable caller bytes', () => {
    const test = fixture();
    const bytes = Uint8Array.from([120, 97, 98, 120]);
    test.reader.push(bytes.subarray(1, 3));
    bytes.fill(99);
    test.reader.push(Buffer.from('\n'));
    expect(test.line).toHaveBeenCalledWith('ab');
  });

  it('stops between lines if its consumer closes the connection', () => {
    const test = fixture();
    test.line.mockImplementation(() => test.reader.stop());
    test.reader.push(Buffer.from('first\nsecond\n'));
    expect(test.line).toHaveBeenCalledExactlyOnceWith('first');
    test.reader.end();
    expect(test.failure).not.toHaveBeenCalled();
  });

  it('contains throwing consumers and failure callbacks', () => {
    const test = fixture();
    test.line.mockImplementation(() => {
      throw new Error('private');
    });
    test.failure.mockImplementation(() => {
      throw new Error('private');
    });
    expect(() =>
      test.reader.push(Buffer.from('first\nsecond\n')),
    ).not.toThrow();
    expect(test.failure).toHaveBeenCalledExactlyOnceWith('consumer-failed');
    expect(test.line).toHaveBeenCalledTimes(1);
  });
});
