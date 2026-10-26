import type { Session } from '@cindy/maker-core';
import { createNativeHistoryJournal, type NativeHistoryPending } from './nativeHistoryJournal.js';

type HistoryResult = Awaited<ReturnType<Session['navigateSessionTree']>>;
type HistoryOptions = NonNullable<Parameters<Session['navigateSessionTree']>[1]>;
type HistorySession = Pick<Session, 'id' | 'sdkSessionId' | 'agentKind' | 'workDir' | 'model'
  | 'restoreSessionTreeHandoff' | 'readNativeEditorDraft' | 'restoreNativeEditorDraft' | 'navigateSessionTreeAndPersist'>;

/** Created once per owned executor, before exposing input. The journal is not
 * a command queue: a new process reconciles the actual branch, never repeats
 * the mutation. The GUI's unsent composer stays in its existing draft store. */
export function createNativeHistoryHandoff<T>(options: {
  root: string;
  session: HistorySession;
  assertCurrent(): void;
  exclusive<R>(operation: () => Promise<R>): Promise<R>;
  configuration?(): string;
  persist(result: HistoryResult): Promise<T>;
}) {
  const { session } = options;
  let pending: NativeHistoryPending | null = null;
  const assertCurrent = () => {
    options.assertCurrent();
    if (pending && (pending.model !== session.model || pending.workingDir !== session.workDir
      || pending.configuration !== options.configuration?.()))
      throw new Error('Native history configuration changed during handoff');
  };
  assertCurrent();
  const openJournal = () => createNativeHistoryJournal(options.root, {
    sessionId: session.id, nativeId: session.sdkSessionId, agentKind: session.agentKind,
    workingDir: session.workDir, model: session.model,
    ...(options.configuration ? { configuration: options.configuration() } : {}),
  });
  let journal = openJournal();
  pending = journal.read();
  if (pending?.replacing && !pending.targetNativeId) throw new Error('Native history replacement outcome is unknown');
  let restoreEditor = pending?.nativeDraft;
  // Synchronous: semantic send and all terminal peers are frozen even while
  // the startup route hydration promise is still pending.
  if (pending) session.restoreSessionTreeHandoff(pending);

  const navigate = (entryId: string, navigation: HistoryOptions) => options.exclusive(async () => {
    assertCurrent();
    // A controller created before another process changed the checkpoint may
    // not adopt that process's mutation or clear its recovery record.
    if (JSON.stringify(journal.read()) !== JSON.stringify(pending))
      throw new Error('Native history checkpoint changed; reopen this task to recover');
    if (restoreEditor !== undefined) {
      await session.restoreNativeEditorDraft(restoreEditor);
      assertCurrent();
      restoreEditor = undefined;
    }
    return session.navigateSessionTreeAndPersist(entryId, navigation, async result => {
      assertCurrent();
      const persisted = await options.persist(result);
      assertCurrent();
      if (!pending) throw new Error('Native history checkpoint is missing');
      // Commit the tombstone before releasing input; disk failure keeps the
      // hold and a retry can safely repeat the idempotent projection only.
      journal.complete(pending);
      pending = null;
      return persisted;
    }, {
      async beforeNavigate() {
        assertCurrent();
        const nativeDraft = await session.readNativeEditorDraft();
        assertCurrent();
        journal = openJournal();
        pending = journal.begin(entryId, nativeDraft);
      },
      async afterNavigate(result) {
        assertCurrent();
        if (!pending) throw new Error('Native history checkpoint is missing');
        pending = journal.recordResult(pending, result);
      },
      async beforeReplacement() {
        assertCurrent();
        if (!pending) throw new Error('Native history checkpoint is missing');
        pending = journal.replace(pending);
      },
      async target(nativeId) {
        assertCurrent();
        if (!pending) throw new Error('Native history checkpoint is missing');
        pending = journal.replace(pending, nativeId);
      },
    });
  });

  return {
    navigate,
    get pending() { return pending !== null; },
    async recover(): Promise<{ result: HistoryResult; persisted: T } | null> {
      const record: NativeHistoryPending | null = pending;
      if (!record) return null;
      assertCurrent();
      // restoreSessionTreeHandoff makes this a readback, including when the
      // previous process died before learning whether navigation succeeded.
      return navigate(record.entryId, {});
    },
  };
}
