/**
 * messagesListImportSideEffects.test.ts — #318 A3。
 * ------------------------------------------------------------------------------------
 * 验证 `local-db:messages:list` 只为带来源前缀的任务运行对应「外部 CLI 历史导入」副作用:
 *   - 普通任务(无 codex-/claude- 前缀) → 两个 importer 都不调用;
 *   - Codex 任务 → 只调用 Codex importer;
 *   - Claude 任务 → 只调用 Claude importer;
 *   - device-link 分页仍跳过 importer;
 *   - importer reject → 被吞并(warn),不冒泡。
 * 既覆盖可注入纯函数 `runMessagesListImportSideEffects`,也通过真实 handler + 真实
 * `runDeviceLinkInvokeContext`(AsyncLocalStorage)做一次集成断言。
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { messages, sessions } from '../../schema';
import type { CurrentDbClientSnapshot } from '../../client/current';
import { RETAINED_COMPANION_DDL } from '../../__tests__/fixtures/retiredCompanionTables';

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  snapshot: null as CurrentDbClientSnapshot | null,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, handler);
    }),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../maker-host/codex-local-sessions', () => ({
  importExternalCodexMessagesForSession: vi.fn(async () => undefined),
  classifyCodexHistoryOversized: vi.fn(async () => false),
}));
vi.mock('../../codexHistoryOversizedUpgrade', () => ({
  maybeUpgradeCodexHistoryOversizedError: vi.fn(async () => ({ result: 'skipped' })),
}));
vi.mock('../../../maker-host/claude-local-sessions', () => ({
  importExternalClaudeCodeMessagesForSession: vi.fn(async () => undefined),
}));
vi.mock('../../../embedders/chat-history-embedder', () => ({
  onMessageCreated: vi.fn(async () => undefined),
}));
vi.mock('../../client/current', () => ({
  getDbClient: () => h.snapshot?.client,
  getCurrentDbClientSnapshot: () => h.snapshot,
}));

import { registerMessageIpc, runMessagesListImportSideEffects } from '../messages';
import { runDeviceLinkInvokeContext } from '../../../device-link/invoke-context';
import { importExternalCodexMessagesForSession } from '../../../maker-host/codex-local-sessions';
import { importExternalClaudeCodeMessagesForSession } from '../../../maker-host/claude-local-sessions';

const codexMock = vi.mocked(importExternalCodexMessagesForSession);
const claudeMock = vi.mocked(importExternalClaudeCodeMessagesForSession);

function createDb(sessionId = 's1'): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'desktop',
      cleared_at INTEGER
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_use_id TEXT,
      agent_meta TEXT,
      agent_kind TEXT,
      created_at INTEGER NOT NULL,
      rewind_at INTEGER
    );
  `);
  sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run(sessionId);
  h.db = drizzle(sqlite, { schema: { messages, sessions } });
  for (const ddl of RETAINED_COMPANION_DDL) sqlite.exec(ddl);
  h.snapshot = { userId: 'import-test', clientEpoch: 1, client: {
    drizzle: h.db,
    query: async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).all(...params),
  } } as unknown as CurrentDbClientSnapshot;
  return sqlite;
}

describe('runMessagesListImportSideEffects (injectable)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('device-link 分页路径(默认 opts)→ 跳过两个 importer', async () => {
    const importCodex = vi.fn(async () => undefined);
    const importClaude = vi.fn(async () => undefined);

    await runMessagesListImportSideEffects('s1', {
      isDeviceLink: () => true,
      importCodex,
      importClaude,
    });

    expect(importCodex).not.toHaveBeenCalled();
    expect(importClaude).not.toHaveBeenCalled();
  });

  it('Codex 首页请求(deviceLinkFirstPage)→ 只跑 Codex importer', async () => {
    // 被控端可能从未本机打开该会话,rollout 从未导入 —— 首页请求必须补导入。
    const importCodex = vi.fn(async () => undefined);
    const importClaude = vi.fn(async () => undefined);

    await runMessagesListImportSideEffects(
      'codex-s1',
      { isDeviceLink: () => true, importCodex, importClaude },
      { deviceLinkFirstPage: true },
    );

    expect(importCodex).toHaveBeenCalledTimes(1);
    expect(importCodex).toHaveBeenCalledWith('codex-s1');
    expect(importClaude).not.toHaveBeenCalled();
  });

  it('Claude 首页请求 → 只跑 Claude importer', async () => {
    const importCodex = vi.fn(async () => undefined);
    const importClaude = vi.fn(async () => undefined);

    await runMessagesListImportSideEffects('claude-s1', {
      isDeviceLink: () => false,
      importCodex,
      importClaude,
    });

    expect(importCodex).not.toHaveBeenCalled();
    expect(importClaude).toHaveBeenCalledTimes(1);
    expect(importClaude).toHaveBeenCalledWith('claude-s1');
  });

  it('普通任务 → 两个 importer 都跳过', async () => {
    const importCodex = vi.fn(async () => undefined);
    const importClaude = vi.fn(async () => undefined);

    await runMessagesListImportSideEffects('s1', {
      isDeviceLink: () => false,
      importCodex,
      importClaude,
    });

    expect(importCodex).not.toHaveBeenCalled();
    expect(importClaude).not.toHaveBeenCalled();
  });

  it('对应 importer reject 被吞并,不冒泡', async () => {
    const importCodex = vi.fn(async () => {
      throw new Error('boom-codex');
    });
    const importClaude = vi.fn(async () => undefined);

    await expect(
      runMessagesListImportSideEffects('codex-s1', {
        isDeviceLink: () => false,
        importCodex,
        importClaude,
      }),
    ).resolves.toBeUndefined();

    expect(importCodex).toHaveBeenCalledTimes(1);
    expect(importClaude).not.toHaveBeenCalled();
  });
});

describe('local-db:messages:list × import side-effects (integration)', () => {
  it('rejects a retained native-import task before touching its original CLI files', async () => {
    const sqlite = createDb('codex-retained');
    try {
      sqlite.exec("INSERT INTO bot_session_links VALUES ('codex-retained')");
      registerMessageIpc();
      await expect(h.handlers.get('local-db:messages:list')!({}, 'codex-retained', {})).rejects.toThrow('[NOT_FOUND]');
      expect(codexMock).not.toHaveBeenCalled();
      expect(claudeMock).not.toHaveBeenCalled();
    } finally { sqlite.close(); }
  });
  beforeEach(() => {
    vi.clearAllMocks();
    h.handlers.clear();
  });

  it('普通任务 invoke → 跳过真实 importer', async () => {
    createDb('s1');
    registerMessageIpc();
    const listHandler = h.handlers.get('local-db:messages:list');
    expect(listHandler).toBeTypeOf('function');

    await listHandler?.({}, 's1', { limit: 10 });

    expect(codexMock).not.toHaveBeenCalled();
    expect(claudeMock).not.toHaveBeenCalled();
  });

  it('device-link Codex 首页 invoke → 只跑真实 Codex importer', async () => {
    createDb('codex-s1');
    registerMessageIpc();
    const listHandler = h.handlers.get('local-db:messages:list');
    expect(listHandler).toBeTypeOf('function');

    const rows = await runDeviceLinkInvokeContext(
      { controllerDeviceId: 'ctrl-1', channel: 'local-db:messages:list' },
      () => listHandler?.({}, 'codex-s1', { limit: 10 }),
    );

    expect(codexMock).toHaveBeenCalledTimes(1);
    expect(codexMock).toHaveBeenCalledWith('codex-s1');
    expect(claudeMock).not.toHaveBeenCalled();
    expect(Array.isArray(rows)).toBe(true);
  });

  it('device-link 分页 invoke(带 beforeTs)→ 跳过真实 importer(#318 性能语义)', async () => {
    createDb('s1');
    registerMessageIpc();
    const listHandler = h.handlers.get('local-db:messages:list');
    expect(listHandler).toBeTypeOf('function');

    const rows = await runDeviceLinkInvokeContext(
      { controllerDeviceId: 'ctrl-1', channel: 'local-db:messages:list' },
      () => listHandler?.({}, 's1', { limit: 10, beforeTs: Date.now() }),
    );

    expect(codexMock).not.toHaveBeenCalled();
    expect(claudeMock).not.toHaveBeenCalled();
    expect(Array.isArray(rows)).toBe(true);
  });
});
