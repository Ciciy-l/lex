import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  owner: { dataOwnerId: 'owner-a', ownerGeneration: 1 },
  query: vi.fn(),
  botLinks: [] as Array<{ botId: string }>,
  workers: [] as Array<{ sessionId: string }>,
  running: new Set<string>(),
  attached: false,
  update: vi.fn(),
  saved: vi.fn(),
  enterLock: vi.fn(),
  beforeCommit: vi.fn(),
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../appSessionState.js', () => ({
  getActiveDataOwnerPushStamp: () => ({ ...h.owner }),
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../localDb/client/current.js', async () => {
  const { botSessionLinks } = await import('../../localDb/schema.js');
  const client = {
    drizzle: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({ limit: table === botSessionLinks ? async () => h.botLinks : h.query }),
          innerJoin: () => ({ where: async () => h.workers }),
        }),
      }),
    },
  };
  return { tryGetDbClient: () => client };
});
vi.mock('../../localDb/ipc/recentWorkdirs.js', () => ({
  normalizeRecentWorkdirPath: (p: string) => p,
  upsertRecentWorkdir: vi.fn(),
}));
vi.mock('../../sidebarSettingsStore.js', () => ({ restoreLocalProjectVisibility: vi.fn() }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../../im/binding.js', () => ({
  bindingStore: { findByTarget: () => (h.attached ? 'im' : null) },
}));
vi.mock('../../localDb/ipc/sessions.js', () => ({ updateSessionInDb: h.update }));

import { createMoveSession, moveSessionProjectFromHost } from '../moveSession.js';

describe('moveSession host', () => {
  let directory: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    directory = await mkdtemp(path.join(os.tmpdir(), 'cindy-move-session-'));
    h.owner = { dataOwnerId: 'owner-a', ownerGeneration: 1 };
    h.running = new Set();
    h.workers = [];
    h.botLinks = [];
    h.attached = false;
    h.enterLock.mockImplementation(() => undefined);
    h.beforeCommit.mockImplementation(() => undefined);
    h.query.mockResolvedValue([
      { id: 'target', status: 'active', remoteHostId: null, source: null, orcaRole: null },
    ]);
    h.update.mockImplementation(async (id, patch, _opts, guard) => {
      h.enterLock();
      guard.assertCurrent();
      await guard.beforeUpdate();
      guard.assertCurrent();
      h.beforeCommit();
      guard.beforeWrite?.();
      h.saved(patch);
      guard.assertCurrent();
      return { id, workingDir: patch.workingDir ?? '/old', workspaceKind: patch.workspaceKind };
    });
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const run = (workingDir: string | null) =>
    createMoveSession((id) => h.running.has(id))({
      callerSessionId: 'caller',
      sessionId: 'target',
      workingDir,
    });

  it('keeps agent self-moves forbidden while the trusted UI uses the same guarded update', async () => {
    const agent = createMoveSession((id) => h.running.has(id));
    expect(await agent({ callerSessionId: 'target', sessionId: 'target', workingDir: directory })).toMatchObject({ ok: false });
    expect(h.update).not.toHaveBeenCalled();
    expect(await moveSessionProjectFromHost((id) => h.running.has(id), 'target', directory, () => {})).toMatchObject({ ok: true, workspaceKind: 'project' });
    h.saved.mockClear();
    h.running.add('target');
    expect(await moveSessionProjectFromHost((id) => h.running.has(id), 'target', null, () => {})).toMatchObject({ ok: false });
    expect(h.saved).not.toHaveBeenCalled();
  });
  it.each(['lock', 'commit'])('rechecks remote authority at %s before moving', async phase => {
    let revoked = false;
    (phase === 'lock' ? h.enterLock : h.beforeCommit).mockImplementationOnce(() => { revoked = true; });
    expect(await moveSessionProjectFromHost(() => false, 'target', directory, () => {
      if (revoked) throw new Error('MIGRATION_ACCESS_REVOKED');
    })).toMatchObject({ ok: false });
    expect(h.saved).not.toHaveBeenCalled();
  });

  it('uses the shared update path for moving projects and preserves cwd when removing grouping', async () => {
    expect(await run(directory)).toMatchObject({
      ok: true,
      workingDir: path.resolve(directory),
      workspaceKind: 'project',
    });
    expect(h.saved).toHaveBeenLastCalledWith({
      workingDir: path.resolve(directory),
      workspaceKind: 'project',
    });
    expect(await run(null)).toMatchObject({
      ok: true,
      workingDir: '/old',
      workspaceKind: 'dialogue',
    });
    expect(h.saved).toHaveBeenLastCalledWith({ workspaceKind: 'dialogue' });
  });
  it.each([false, true])(
    'rechecks running state after acquiring the route lock (%s)',
    async (target) => {
      h.enterLock.mockImplementation(() => h.running.add('target'));
      expect(await run(target ? directory : null)).toMatchObject({ errorCode: 'PRECONDITION_FAILED' });
      expect(h.saved).not.toHaveBeenCalled();
    },
  );
  it('does not report a committed move as rejected when IM attaches after the write', async () => {
    h.saved.mockImplementationOnce(() => { h.attached = true; });
    expect(await run(null)).toMatchObject({ ok: true, workspaceKind: 'dialogue' });
  });

  it('rejects IM-controlled tasks and running Orca workers', async () => {
    h.attached = true;
    expect(await run(null)).toMatchObject({ errorCode: 'PRECONDITION_FAILED' });
    h.attached = false;
    h.query.mockResolvedValue([{ id: 'target', status: 'active', orcaRole: 'lead' }]);
    h.workers = [{ sessionId: 'worker' }];
    h.running.add('worker');
    expect(await run(null)).toMatchObject({ errorCode: 'PRECONDITION_FAILED' });
    expect(h.saved).not.toHaveBeenCalled();
  });
  it.each([
    [[], 'NOT_FOUND'],
    [[{ status: 'active', remoteHostId: 'ssh' }], 'UNSUPPORTED_CAPABILITY'],
    [[{ status: 'archived' }], 'PRECONDITION_FAILED'],
    [[{ status: 'deleted' }], 'PRECONDITION_FAILED'],
    [[{ status: 'active', source: 'review' }], 'UNSUPPORTED_CAPABILITY'],
  ])('rejects an unavailable target %j', async (rows, errorCode) => {
    h.query.mockResolvedValueOnce([{ id: 'caller' }]).mockResolvedValueOnce(rows);
    expect(await run(null)).toMatchObject({ errorCode });
    expect(h.saved).not.toHaveBeenCalled();
  });
  it('rejects account switches while queued behind the route lock', async () => {
    h.enterLock.mockImplementation(() => {
      h.owner.ownerGeneration++;
    });
    expect(await run(null)).toMatchObject({ errorCode: 'PRECONDITION_FAILED' });
    expect(h.saved).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'keeps Bot-owned tasks in their managed workspace (project=%s)',
    async (project) => {
      const workingDir = project ? directory : null;
      // Source-only records and legacy linked records share the same restriction.
      h.query
        .mockResolvedValueOnce([{ id: 'caller' }])
        .mockResolvedValueOnce([{ id: 'target', status: 'active', source: 'bot' }]);
      expect(await run(workingDir)).toMatchObject({ errorCode: 'UNSUPPORTED_CAPABILITY' });
      h.enterLock.mockImplementationOnce(() => {
        h.botLinks = [{ botId: 'bot' }];
      });
      expect(await run(workingDir)).toMatchObject({ errorCode: 'UNSUPPORTED_CAPABILITY' });
      expect(h.saved).not.toHaveBeenCalled();
      // A normal delegated task is not a Bot-owned task; parent linkage does not restrict moving it.
      h.botLinks = [];
      h.query.mockResolvedValue([{ id: 'target', status: 'active', parentSessionId: 'bot-task' }]);
      expect(await run(workingDir)).toMatchObject({ ok: true });
    },
  );
  it('rejects missing directories, files, and relative paths without writing', async () => {
    expect(await run(path.join(directory, 'missing'))).toMatchObject({ errorCode: 'NOT_FOUND' });
    await writeFile(path.join(directory, 'file'), 'keep');
    expect(await run(path.join(directory, 'file'))).toMatchObject({ ok: false });
    expect(await run('relative')).toMatchObject({ errorCode: 'INVALID_ARGS' });
    expect(h.saved).not.toHaveBeenCalled();
  });
});
