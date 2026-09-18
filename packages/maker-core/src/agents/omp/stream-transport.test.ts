import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createOmpStreamTransport } from './stream-transport.js';
import { OmpRpcClient } from './rpc-client.js';
import { OMP_MAX_FRAME_BYTES } from './jsonl-reader.js';

function fixture(input = new PassThrough()) {
  const output = new PassThrough();
  const terminate = vi.fn();
  const transport = createOmpStreamTransport(input, output, terminate);
  return { input, output, terminate, transport };
}

describe('OMP stream transport', () => {
  it.each(['input', 'output'])(
    'rejects object-mode %s before registering listeners',
    (side) => {
      const input = new PassThrough({ objectMode: side === 'input' });
      const output = new PassThrough({ objectMode: side === 'output' });
      const terminate = vi.fn();
      expect(() => createOmpStreamTransport(input, output, terminate)).toThrow(
        'byte streams',
      );
      expect(input.eventNames()).toEqual(['prefinish']);
      expect(output.eventNames()).toEqual(['prefinish']);
      expect(terminate).not.toHaveBeenCalled();
      input.destroy();
      output.destroy();
    },
  );

  it('counts queued UTF-8 bytes even when decodeStrings is disabled', () => {
    const writes = vi.fn();
    const input = new Writable({
      decodeStrings: false,
      write: (chunk) => {
        writes(chunk);
      },
    });
    const output = new PassThrough();
    const terminate = vi.fn();
    const transport = createOmpStreamTransport(input, output, terminate);
    transport.writeLine('中'.repeat(150000));
    transport.writeLine('中'.repeat(150000));
    expect(input.writableLength).toBe(900002);
    expect(Buffer.isBuffer(writes.mock.calls[0][0])).toBe(true);
    expect(() => transport.writeLine('中'.repeat(150000))).toThrow(
      'backpressure',
    );
    expect(input.writableLength).toBe(900002);
    expect(terminate).toHaveBeenCalledOnce();
    input.destroy();
    output.destroy();
  });

  it('writes UTF-8 regardless of the stream default encoding', () => {
    const test = fixture();
    test.input.setDefaultEncoding('utf16le');
    test.transport.writeLine('{}');
    expect(test.input.read()).toEqual(Buffer.from([0x7b, 0x7d, 0x0a]));
    test.transport.close();
  });

  it('rejects pre-existing queued data whose byte accounting is not owned by this transport', () => {
    const input = new Writable({
      decodeStrings: false,
      write: () => undefined,
    });
    const output = new PassThrough();
    input.write('中');
    expect(() => createOmpStreamTransport(input, output, vi.fn())).toThrow(
      'empty dedicated',
    );
    input.destroy();
    output.destroy();
  });

  it.each(['close', 'error', 'read-failure'])(
    'finishes teardown despite throwing removeListener hooks: %s',
    async (trigger) => {
      const test = fixture();
      const closed = vi.fn(() => test.transport.close());
      const other = vi.fn();
      test.transport.onLine(vi.fn());
      test.transport.onClose(closed);
      test.transport.onClose(other);
      const removed = vi.fn(() => {
        test.transport.close();
        throw new Error('synthetic-remove-failed');
      });
      test.output.on('removeListener', removed);
      test.input.on('removeListener', removed);
      expect(() => {
        if (trigger === 'close') test.transport.close();
        else if (trigger === 'error')
          test.output.emit('error', new Error('synthetic'));
        else test.output.write(Buffer.alloc(OMP_MAX_FRAME_BYTES + 2, 97));
      }).not.toThrow();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(removed).toHaveBeenCalledTimes(4);
      expect(closed).toHaveBeenCalledOnce();
      expect(other).toHaveBeenCalledOnce();
      expect(test.terminate).toHaveBeenCalledOnce();
      expect(test.transport.isClosed()).toBe(true);
      expect(test.output.listenerCount('data')).toBe(0);
      expect(test.output.listenerCount('end')).toBe(0);
      expect(test.output.listenerCount('close')).toBe(0);
      expect(test.input.listenerCount('close')).toBe(0);
      expect(() => test.transport.close()).not.toThrow();
      expect(() => test.input.emit('error', new Error('late'))).not.toThrow();
      expect(test.terminate).toHaveBeenCalledOnce();
    },
  );

  it('delivers buffered startup lines only after the RPC consumer subscribes', async () => {
    const test = fixture();
    test.output.write('{"type":"ready"}\n');
    const event = vi.fn();
    const client = new OmpRpcClient(test.transport, event, () =>
      test.transport.close(),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(event).toHaveBeenCalledExactlyOnceWith({ type: 'ready' });
    client.close();
    expect(test.terminate).toHaveBeenCalledOnce();
  });

  it('frames exactly one request and allows interaction responses before ACK', async () => {
    const test = fixture();
    const client = new OmpRpcClient(test.transport, vi.fn(), () =>
      test.transport.close(),
    );
    const pending = client.request({ type: 'prompt', message: '/pick' });
    client.respondToUi('pick-1', { value: 'yes' });
    const sent = test.input
      .read()
      .toString()
      .trim()
      .split('\n')
      .map((line: string) => JSON.parse(line));
    expect(sent).toEqual([
      { type: 'prompt', message: '/pick', id: pending.id },
      { type: 'extension_ui_response', id: 'pick-1', value: 'yes' },
    ]);
    test.output.write(
      JSON.stringify({
        type: 'response',
        command: 'prompt',
        id: pending.id,
        success: true,
      }) + '\n',
    );
    await pending.response;
    client.close();
  });

  it('rejects queued RPC requests when the output byte limit is exceeded', async () => {
    const test = fixture();
    const client = new OmpRpcClient(test.transport, vi.fn(), () =>
      test.transport.close(),
    );
    const pending = client.request({ type: 'get_state' });
    const rejected = expect(pending.response).rejects.toThrow('closed');
    test.output.write(Buffer.alloc(OMP_MAX_FRAME_BYTES + 2, 97));
    await rejected;
    expect(test.terminate).toHaveBeenCalledOnce();
    test.output.destroy();
    test.input.destroy();
  });

  it('fails closed at the queued-byte cap without retrying stalled writes', () => {
    const writes = vi.fn();
    const input = new Writable({
      write: (chunk) => {
        writes(chunk);
      },
    });
    const output = new PassThrough();
    const terminate = vi.fn();
    const transport = createOmpStreamTransport(input, output, terminate);
    transport.writeLine('a'.repeat(OMP_MAX_FRAME_BYTES));
    expect(() => transport.writeLine('b')).toThrow('backpressure');
    expect(writes).toHaveBeenCalledOnce();
    expect(input.writableLength).toBe(OMP_MAX_FRAME_BYTES + 1);
    expect(terminate).toHaveBeenCalledOnce();
    input.destroy();
    output.destroy();
  });

  it.each([
    'first\nsecond',
    'first\rsecond',
    'a'.repeat(OMP_MAX_FRAME_BYTES + 1),
  ])('rejects malformed or oversized outbound lines before writing', (line) => {
    const test = fixture();
    expect(() => test.transport.writeLine(line)).toThrow();
    expect(test.input.read()).toBeNull();
    test.transport.close();
  });

  it('isolates listener and termination exceptions, including late stream errors', async () => {
    const test = fixture();
    const closed = vi.fn(() => {
      throw new Error('private');
    });
    const other = vi.fn();
    test.terminate.mockImplementation(() => {
      throw new Error('private');
    });
    test.transport.onClose(closed);
    test.transport.onClose(other);
    test.transport.onLine(() => {
      throw new Error('private');
    });
    test.output.write('line\n');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(test.transport.isClosed()).toBe(true);
    expect(closed).toHaveBeenCalledOnce();
    expect(other).toHaveBeenCalledOnce();
    expect(test.terminate).toHaveBeenCalledOnce();
    expect(() => test.output.emit('error', new Error('late'))).not.toThrow();
    expect(() => test.input.emit('error', new Error('late'))).not.toThrow();
  });
});
