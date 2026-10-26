import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as atomic from '../../utils/atomicWriteFile.js';
import { createNativeHistoryJournal, readNativeHistoryForClear } from '../nativeHistoryJournal.js';
import { withNativeHistoryOperation } from '../nativeHistoryOperation.js';
import { withNativeHistoryClear, finishCommittedNativeHistoryClear, type NativeHistoryClearState } from '../nativeHistoryClear.js';

async function fixture(run: (f: ReturnType<typeof setup>) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lex-history-clear-'));
  try { await run(setup(root)); } finally { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); }
}
function setup(root: string) {
  const identity = { sessionId: 'task', nativeId: path.join(root, 'source.jsonl'), agentKind: 'pi', workingDir: root, model: 'exact' };
  const journal = createNativeHistoryJournal(root, identity);
  journal.replace(journal.begin('chosen', 'unsent'), path.join(root, 'branch.jsonl'));
  let state: NativeHistoryClearState = { nativeId: identity.nativeId, clearedAt: null };
  let current = true;
  const close = vi.fn(async () => {});
  const deps = { root, sessionId: identity.sessionId, assertCurrent() { if (!current) throw new Error('owner changed'); },
    readState: async () => state, executor: { ...identity, close } };
  const commit = vi.fn(async (guard?: { expected: NativeHistoryClearState; at: number }) => {
    state = { nativeId: null, clearedAt: guard?.at ?? 500 }; return 'cleared';
  });
  return { root, identity, journal, deps, close, commit, changeOwner() { current = false; } };
}

describe('explicit native history clear retirement', () => {
  it('retires only after exit and durable clear, then permits a new native ID across journal reopen', async () => fixture(async f => {
    expect(() => createNativeHistoryJournal(f.root, { ...f.identity, nativeId: path.join(f.root, 'new.jsonl') }).read()).toThrow('identity changed');
    await expect(withNativeHistoryClear(f.deps, 500, f.commit)).resolves.toBe('cleared');
    expect(f.close).toHaveBeenCalledOnce(); expect(f.commit).toHaveBeenCalledOnce();
    expect(f.close.mock.invocationCallOrder[0]).toBeLessThan(f.commit.mock.invocationCallOrder[0]!);
    expect(createNativeHistoryJournal(f.root, { ...f.identity, nativeId: path.join(f.root, 'new.jsonl') }).read()).toBeNull();
    expect(await finishCommittedNativeHistoryClear({ ...f.deps, executor: undefined })).toBe(false);
  }));

  it('does not clear or retire an executor with unknown exit; an explicit retry confirms the same executor', async () => fixture(async f => {
    f.close.mockRejectedValueOnce(new Error('exit unconfirmed'));
    await expect(withNativeHistoryClear(f.deps, 500, f.commit)).rejects.toThrow('exit unconfirmed');
    expect(f.commit).not.toHaveBeenCalled(); expect(f.journal.read()?.clear).toBeUndefined();
    await withNativeHistoryClear(f.deps, 501, f.commit);
    expect(f.close).toHaveBeenCalledTimes(2); expect(f.journal.read()).toBeNull();
  }));

  it('keeps a durable exit-confirmed intent on DB failure and requires explicit clear to retry it', async () => fixture(async f => {
    f.commit.mockRejectedValueOnce(new Error('db unavailable'));
    await expect(withNativeHistoryClear(f.deps, 500, f.commit)).rejects.toThrow('db unavailable');
    expect(() => f.journal.read()).toThrow('clear is pending');
    const restarted = { ...f.deps, executor: undefined };
    await expect(finishCommittedNativeHistoryClear(restarted)).rejects.toThrow('has not committed');
    await withNativeHistoryClear(restarted, 600, f.commit);
    expect(f.close).toHaveBeenCalledOnce(); expect(f.journal.read()).toBeNull();
  }));

  it('recovers a tombstone failure using the committed DB boundary without repeating clear or reopening an executor', async () => fixture(async f => {
    const original = atomic.atomicWriteFileSync;
    const write = vi.spyOn(atomic, 'atomicWriteFileSync').mockImplementation((file, value, ...rest) => {
      if (value === 'null') throw new Error('tombstone unavailable');
      return original(file, value, ...rest);
    });
    await expect(withNativeHistoryClear(f.deps, 500, f.commit)).rejects.toThrow('tombstone unavailable');
    expect(readNativeHistoryForClear(f.root, 'task')?.clear?.at).toBe(500);
    write.mockRestore();
    expect(await finishCommittedNativeHistoryClear({ ...f.deps, executor: undefined })).toBe(true);
    expect(f.commit).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce();
    expect(f.journal.read()).toBeNull();
  }));

  it('rejects owner changes, foreign executors and stored identities without retiring another operation', async () => fixture(async f => {
    await expect(withNativeHistoryClear({ ...f.deps, executor: { ...f.deps.executor, nativeId: 'foreign' } }, 500, f.commit)).rejects.toThrow('original native task');
    await expect(withNativeHistoryClear({ ...f.deps, readState: async () => ({ nativeId: 'foreign', clearedAt: null }) }, 500, f.commit)).rejects.toThrow('identity changed');
    f.close.mockImplementationOnce(async () => f.changeOwner());
    await expect(withNativeHistoryClear(f.deps, 500, f.commit)).rejects.toThrow('owner changed');
    expect(f.commit).not.toHaveBeenCalled(); expect(f.journal.read()).not.toBeNull();
    expect(readNativeHistoryForClear(f.root, 'another-task')).toBeNull();
  }));

  it('cannot race navigation through the shared cross-process operation lock', async () => fixture(async f => {
    await withNativeHistoryOperation(f.root, 'task', async () => {
      await expect(withNativeHistoryClear(f.deps, 500, f.commit)).rejects.toThrow('busy');
    });
    expect(f.close).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled();
    expect(f.journal.read()).not.toBeNull();
  }));

  it('keeps the original checkpoint when exit succeeds but the clear intent cannot be written', async () => fixture(async f => {
    const before = f.journal.read();
    const write = vi.spyOn(atomic, 'atomicWriteFileSync').mockImplementationOnce(() => { throw new Error('intent unavailable'); });
    await expect(withNativeHistoryClear(f.deps, 500, f.commit)).rejects.toThrow('intent unavailable');
    write.mockRestore();
    expect(f.close).toHaveBeenCalledOnce(); expect(f.commit).not.toHaveBeenCalled();
    expect(f.journal.read()).toEqual(before);
    await expect(withNativeHistoryClear({ ...f.deps, executor: undefined }, 501, f.commit)).rejects.toThrow('original native task');
    expect(f.journal.read()).toEqual(before);
  }));

  it('cannot close a newly appeared executor using an earlier exit-confirmed intent', async () => fixture(async f => {
    f.commit.mockRejectedValueOnce(new Error('DB unavailable'));
    await expect(withNativeHistoryClear(f.deps, 500, f.commit)).rejects.toThrow('DB unavailable');
    const closeNew = vi.fn();
    await expect(withNativeHistoryClear({ ...f.deps, executor: { ...f.deps.executor, close: closeNew } }, 600, f.commit))
      .rejects.toThrow('executor appeared');
    expect(closeNew).not.toHaveBeenCalled(); expect(f.commit).toHaveBeenCalledOnce();
  }));
});
