import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeNativeInputPreparations, type ClaudeNativeInputPreparation } from './native-input-preparation.js';

const owners: ClaudeNativeInputPreparations[] = [];
afterEach(() => { for (const owner of owners.splice(0)) owner.close(); vi.useRealTimers(); });
const content = [{ type: 'text', text: 'native' }, { type: 'image', source: { type: 'base64', data: 'fixture' } }];
const proposal = () => ({ uuid: 'row', door: 'prompt', origin: { kind: 'composer' }, message: { type: 'user', content } });
const recorded = (blocks: unknown = content) => ({ sequence: 1, kind: 'session.append',
  value: { ...proposal(), result: { uuid: 'row', message: { type: 'user', content: blocks } } } });
function fixture(prepare: (input: ClaudeNativeInputPreparation) => Promise<void>, timeout = 120_000) {
  const owner = new ClaudeNativeInputPreparations('native-session', prepare, timeout); owners.push(owner); return owner;
}

describe('Claude pre-append input preparation', () => {
  it('returns transformed content before append, then waits for the actual native receipt before model admission', async () => {
    let continued = false;
    const rewritten = [{ type: 'text', text: 'host vision result' }];
    const owner = fixture(async input => {
      expect(input.row).toMatchObject({ sessionId: 'native-session', uuid: 'row' });
      await input.accept(rewritten); continued = true;
    });
    const controller = new AbortController();
    expect(await owner.request(proposal(), controller.signal)).toEqual({ allow: true, content: rewritten });
    expect(continued).toBe(false);
    let admitted = false;
    const admission = owner.admit(['row'], controller.signal).then(() => { admitted = true; });
    await Promise.resolve(); expect(admitted).toBe(false);
    owner.record(recorded(rewritten));
    await admission; expect(continued).toBe(true);
  });

  it('does not treat normal request retirement after append as input cancellation', async () => {
    const controller = new AbortController();
    const owner = fixture(async input => { await input.accept(input.row.message.content); });
    await owner.request(proposal(), controller.signal);
    owner.record(recorded()); controller.abort();
    await expect(owner.admit(['row'], new AbortController().signal)).resolves.toBeUndefined();
  });

  it('refuses replaced media, changed native receipts, and mismatched row identities', async () => {
    const owner = fixture(async input => { await input.accept([{ type: 'image', source: { data: 'other' } }]); });
    expect(await owner.request(proposal(), new AbortController().signal)).toEqual({ allow: false });
    await expect(owner.admit(['row'], new AbortController().signal)).rejects.toThrow();
    const mismatch = fixture(async input => { await input.accept(content); });
    await mismatch.request(proposal(), new AbortController().signal);
    mismatch.record(recorded([{ type: 'text', text: 'another mod changed content' }]));
    await expect(mismatch.admit(['row'], new AbortController().signal)).rejects.toThrow();
  });

  it('fails admission for a refused callback or a callback that never accepts', async () => {
    for (const handler of [async () => { throw new Error('refused'); }, async () => {}]) {
      const owner = fixture(handler);
      expect(await owner.request(proposal(), new AbortController().signal)).toEqual({ allow: false });
      await expect(owner.admit(['row'], new AbortController().signal)).rejects.toThrow();
    }
  });

  it('bounds an uncooperative host callback and fences its late continuation', async () => {
    vi.useFakeTimers();
    let request!: ClaudeNativeInputPreparation;
    const owner = fixture(async input => { request = input; await new Promise(() => {}); }, 100);
    const result = owner.request(proposal(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(101);
    expect(await result).toEqual({ allow: false });
    await expect(owner.admit(['row'], new AbortController().signal)).rejects.toThrow('cancelled');
    await expect(request.accept(content)).rejects.toThrow('no longer current');
  });

  it('rejects duplicate rows, sidechains, and metadata before invoking the host', async () => {
    const prepare = vi.fn(async (input: ClaudeNativeInputPreparation) => { await input.accept(content); });
    const owner = fixture(prepare), controller = new AbortController();
    await owner.request(proposal(), controller.signal);
    for (const raw of [proposal(), { ...proposal(), uuid: 'child', agentId: 'child' },
      { ...proposal(), uuid: 'meta', message: { type: 'user', content, isMeta: true } }]) {
      await expect(owner.request(raw, controller.signal)).rejects.toThrow('Invalid');
    }
    expect(prepare).toHaveBeenCalledOnce();
  });

  it('retires turn-owned preparations and rejects any delayed acceptance after runtime close', async () => {
    let held!: ClaudeNativeInputPreparation;
    const owner = fixture(async input => { held = input; await new Promise(() => {}); });
    const response = owner.request(proposal(), new AbortController().signal);
    await Promise.resolve();
    owner.record({ sequence: 2, kind: 'turn.start', value: { turnId: 'turn', messageIds: ['row'] } });
    owner.record({ sequence: 3, kind: 'turn.complete', value: { turnId: 'turn' } });
    expect(await response).toEqual({ allow: false });
    await expect(held.accept(content)).rejects.toThrow('no longer current');
    owner.close();
    await expect(owner.request(proposal(), new AbortController().signal)).rejects.toThrow('Invalid');
  });
});
