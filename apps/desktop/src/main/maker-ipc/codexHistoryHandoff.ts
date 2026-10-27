import { and, eq, isNull } from 'drizzle-orm';
import type { DbClient } from '../localDb/client/DbClient.js';
import { sessions } from '../localDb/schema.js';
import { NATIVE_HISTORY_HANDOFF, NATIVE_HISTORY_RESUME, type StartSessionOptions } from '@cindy/maker-core';
import { createNativeHistoryJournal, nativeHistoryExecutorHasExited, type NativeHistoryIdentity } from './nativeHistoryJournal.js';
import { withNativeHistoryOperation } from './nativeHistoryOperation.js';

/** Full-history Codex forks share the existing journal, clear lock and owner
 * boundary. No prompt, tool result or encrypted compaction is reconstructed. */
export async function prepareCodexHistoryHandoff(options: {
  root: string;
  start: StartSessionOptions;
  read(): Promise<NativeHistoryIdentity>;
  assertCurrent(): void;
  commit(identity: NativeHistoryIdentity, target: string): Promise<void>;
  hold(instanceId: string, source: string, operation: (target: (id: string) => void) => Promise<void>): Promise<void>;
  /** Close only the captured executor; rejection is not an exit receipt. */
  retire?(instanceId: string): Promise<void>;
}) {
  const persisted = new Set<string>();
  const { start, root, assertCurrent } = options;
  let startup: NativeHistoryIdentity | undefined;
  let startupOperationId: string | undefined;
  let startupWriterPid: number | undefined;
  if (start.resumeSessionId) {
    startup = await options.read(); assertCurrent();
    if (startup.nativeId !== start.resumeSessionId) throw new Error('Codex history startup identity changed');
    await withNativeHistoryOperation(root, startup.sessionId, async () => {
      assertCurrent();
      const journal = createNativeHistoryJournal(root, startup!);
      const pending = journal.read();
      if (pending) {
        if (!pending.replacing || !pending.targetNativeId) throw new Error('Codex history replacement outcome is unknown');
        if (!nativeHistoryExecutorHasExited(pending)) throw new Error('Codex history writer exit is unconfirmed');
        startupOperationId = pending.operationId;
        start.resumeSessionId = pending.targetNativeId;
        start[NATIVE_HISTORY_RESUME] = { source: pending.nativeId, target: pending.targetNativeId };
      }
    });
  }
  start[NATIVE_HISTORY_HANDOFF] = {
    isPersisted: id => persisted.has(id),
    async starting(writerPid) {
      if (!start[NATIVE_HISTORY_RESUME]) return;
      if (!writerPid || !Number.isSafeInteger(writerPid) || writerPid <= 0) throw new Error('Codex history writer identity unavailable');
      await withNativeHistoryOperation(root, startup!.sessionId, async () => {
        assertCurrent();
        const journal = createNativeHistoryJournal(root, startup!);
        const pending = journal.read();
        if (pending?.operationId !== startupOperationId || !pending || !nativeHistoryExecutorHasExited(pending))
          throw new Error('Codex history writer changed before resume');
        // Persist the new child BEFORE any thread resume. A crash during this
        // startup must not reuse the previous executor's exit receipt.
        journal.executorRetired(pending, false, writerPid);
        startupWriterPid = writerPid;
      });
    },
    async recover(nativeId, providerId) {
      if (!start[NATIVE_HISTORY_RESUME]) return;
      await withNativeHistoryOperation(root, startup!.sessionId, async () => {
        assertCurrent();
        const journal = createNativeHistoryJournal(root, startup!);
        const pending = journal.read();
        if (!pending?.replacing || pending.operationId !== startupOperationId || !startupWriterPid
          || pending.executorPid !== startupWriterPid || pending.executorRetired
          || pending.targetNativeId !== nativeId || providerId !== 'cindy_summary')
          throw new Error('Codex history replacement readback changed');
        await options.commit(pending, nativeId); assertCurrent();
        journal.complete(pending); persisted.add(nativeId);
      });
    },
    async replace(source, instanceId, operation, writerPid) {
      assertCurrent();
      if (!writerPid || !Number.isSafeInteger(writerPid) || writerPid <= 0) throw new Error('Codex history writer identity unavailable');
      const identity = await options.read(); assertCurrent();
      if (identity.nativeId !== source) throw new Error('Codex history source changed');
      await options.hold(instanceId, source, target => withNativeHistoryOperation(root, identity.sessionId, async () => {
        assertCurrent();
        const journal = createNativeHistoryJournal(root, identity);
        if (journal.read()) throw new Error('Codex history recovery pending; reopen without repeating the fork');
        let pending = journal.replace(journal.begin('codex-summary'));
        pending = journal.executorRetired(pending, false, writerPid);
        let committed = false;
        try { await operation({
          async target(id) {
            // This checkpoint may receive a late native receipt. Its exact
            // operation and owner must still exist; never create a new record.
            assertCurrent(); pending = journal.replace(pending, id); target(id);
          },
          async commit() {
            assertCurrent();
            if (!pending.targetNativeId) throw new Error('Codex history target is unconfirmed');
            await options.commit(pending, pending.targetNativeId); assertCurrent();
            persisted.add(pending.targetNativeId); committed = true;
          },
        });
        assertCurrent();
        if (!committed) throw new Error('Codex history replacement has not committed');
        journal.complete(pending);
        } catch (error) {
          if (options.retire) {
            await options.retire(instanceId); assertCurrent();
            journal.executorRetired(pending, true);
          }
          throw error;
        }
      }));
    },
  };
}

type CodexHistoryRow = Pick<typeof sessions.$inferSelect, 'id' | 'status' | 'agentKind' | 'remoteHostId'
  | 'sdkSessionId' | 'model' | 'workingDir' | 'providerId' | 'effort' | 'permissionMode' | 'fastMode' | 'clearedAt'>;
export function createCodexHistoryDatabase(db: Pick<DbClient, 'drizzle'>, sessionId: string,
  assertCurrent: () => void, configuration: (row: CodexHistoryRow) => string) {
  const read = async () => {
    assertCurrent();
    const [row] = await db.drizzle.select({ id: sessions.id, status: sessions.status, agentKind: sessions.agentKind,
      remoteHostId: sessions.remoteHostId, sdkSessionId: sessions.sdkSessionId, model: sessions.model, workingDir: sessions.workingDir,
      providerId: sessions.providerId, effort: sessions.effort, permissionMode: sessions.permissionMode, fastMode: sessions.fastMode,
      clearedAt: sessions.clearedAt }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    assertCurrent();
    if (!row || row.status !== 'active' || row.agentKind !== 'codex' || row.remoteHostId || !row.sdkSessionId || !row.model || !row.workingDir)
      throw new Error('Codex history task no longer matches');
    return { row, identity: { sessionId, nativeId: row.sdkSessionId, agentKind: 'codex', workingDir: row.workingDir,
      model: row.model, clearedAt: row.clearedAt, configuration: configuration(row) } };
  };
  return { read: async () => (await read()).identity,
    async commit(identity: NativeHistoryIdentity, target: string) {
      const { row, identity: current } = await read();
      if (![identity.nativeId, target].includes(current.nativeId)
        || Object.entries(current).some(([key, value]) => key !== 'nativeId' && identity[key as keyof NativeHistoryIdentity] !== value))
        throw new Error('Codex history configuration or clear boundary changed');
      const result = await db.drizzle.update(sessions).set({ sdkSessionId: target, updatedAt: Date.now() }).where(and(
        eq(sessions.id, sessionId), eq(sessions.status, 'active'), eq(sessions.agentKind, 'codex'), isNull(sessions.remoteHostId),
        eq(sessions.sdkSessionId, row.sdkSessionId!), eq(sessions.model, row.model!), eq(sessions.workingDir, row.workingDir!),
        row.providerId === null ? isNull(sessions.providerId) : eq(sessions.providerId, row.providerId),
        eq(sessions.effort, row.effort), eq(sessions.fastMode, row.fastMode), eq(sessions.permissionMode, row.permissionMode),
        row.clearedAt === null ? isNull(sessions.clearedAt) : eq(sessions.clearedAt, row.clearedAt),
      )).run();
      assertCurrent();
      if (result.changes !== 1) throw new Error('Codex history commit was superseded');
    },
  };
}
