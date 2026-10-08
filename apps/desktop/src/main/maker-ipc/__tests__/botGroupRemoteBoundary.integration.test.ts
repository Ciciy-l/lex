import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildDbWorkerBundle, createMigratedSmokeDb } from '../../localDb/__tests__/dbWorkerTestUtils.js';
import { createDrizzleProxy } from '../../localDb/client/drizzleProxy.js';
import { WorkerThreadTransport } from '../../localDb/client/WorkerThreadTransport.js';

const h = vi.hoisted(() => ({
  client: null as any,
}));

vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => {
    if (!h.client) throw new Error('integration DbClient is not ready');
    return h.client;
  },
}));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => ({ owner: 'integration-owner' }),
  isDataOwnerBroadcastScopeCurrent: () => true,
}));

import { remoteResourceRegistry } from '../../device-link/remoteResourceRegistry.js';
import { createBotGroupChatService, type BotGroupChatService } from '../botGroupChatService.js';
import { registerBotGroupRemoteResourceProvider } from '../botGroupRemoteResourceProvider.js';
import { createBotGroupAttachmentUploadRegistry } from '../botGroupAttachmentUploadRegistry.js';
import { BOT_GROUP_REMOTE_COLLECTION_ID, BOT_GROUP_REMOTE_RESOURCE_KIND } from '../../../shared/botGroupChat.js';

const remoteClient = { protocolVersion: 1, primitives: [], locale: 'en' };
const remoteConnection = {};

function seedSchema(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec([
    "CREATE TABLE bot_profiles (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', avatar TEXT NOT NULL DEFAULT '🤖', avatar_color TEXT NOT NULL DEFAULT 'violet', status TEXT NOT NULL DEFAULT 'active', hidden_at INTEGER, pinned_at INTEGER, attention_reason TEXT, attention_at INTEGER, current_version INTEGER NOT NULL DEFAULT 1, canonical_session_id TEXT, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);",
    "CREATE TABLE bot_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, reply_mode TEXT NOT NULL DEFAULT 'all', speaking_mode TEXT NOT NULL DEFAULT 'auto', organizer_bot_id TEXT, project_dir TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
    "CREATE TABLE bot_group_members (group_id TEXT NOT NULL REFERENCES bot_groups(id) ON DELETE CASCADE, bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE, position INTEGER NOT NULL, last_seen_sequence INTEGER NOT NULL DEFAULT 0, joined_at INTEGER NOT NULL, PRIMARY KEY (group_id, bot_id));",
    "CREATE TABLE bot_group_messages (id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES bot_groups(id) ON DELETE CASCADE, sequence INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'message', author_kind TEXT NOT NULL, author_bot_id TEXT, author_name TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', mentions_json TEXT NOT NULL, notice_code TEXT, client_id TEXT, plan_id TEXT, files_json TEXT NOT NULL DEFAULT '[]', attachments_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, UNIQUE (group_id, sequence), UNIQUE (group_id, client_id));",
    "CREATE TABLE bot_group_plans (id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES bot_groups(id) ON DELETE CASCADE, status TEXT NOT NULL, request_text TEXT NOT NULL, attachments_json TEXT NOT NULL DEFAULT '[]', organizer_bot_id TEXT NOT NULL, organizer_name TEXT NOT NULL, current_step INTEGER, work_dir TEXT, branch TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
    "CREATE TABLE bot_group_plan_steps (plan_id TEXT NOT NULL REFERENCES bot_group_plans(id) ON DELETE CASCADE, position INTEGER NOT NULL, bot_id TEXT NOT NULL, bot_name TEXT NOT NULL, task TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', result_message_id TEXT, started_at INTEGER, finished_at INTEGER, PRIMARY KEY (plan_id, position));",
    "INSERT INTO bot_profiles (id, display_name, description, created_at, updated_at) VALUES ('mimi', '咪咪', 'planner', 1, 1), ('abu', '阿布', 'builder', 1, 1), ('xiaoman', '小满', 'designer', 1, 1);",
  ].join(String.fromCharCode(10)));
  db.close();
}

function clientFor(transport: WorkerThreadTransport): any {
  return {
    drizzle: createDrizzleProxy(transport),
    tx: (name: string, args: unknown, transferList?: unknown[], beforeDispatch?: () => void) =>
      transport.send('tx', { name, args }, transferList, beforeDispatch),
    query: (sql: string, params: unknown[] = []) => transport.send('query', { sql, params }),
    queryOne: (sql: string, params: unknown[] = []) => transport.send('queryOne', { sql, params }),
    exec: (sql: string, params: unknown[] = []) => transport.send('exec', { sql, params }),
    dispose: () => transport.close(),
  };
}

function ref(id: string) {
  return { collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, kind: BOT_GROUP_REMOTE_RESOURCE_KIND, id };
}

function context(assertCurrent: () => void = () => undefined) {
  return { controllerDeviceId: 'peer-a', client: remoteConnection, linkEpoch: 1, assertCurrent };
}

describe('bot-group remote resource to worker boundary', () => {
  let rootDir: string;
  let workerScriptPath: string;
  let dbPath: string;
  let drizzleDir: string;
  let peerA: WorkerThreadTransport;
  let peerB: WorkerThreadTransport;
  let service: BotGroupChatService;
  let uploadRegistry: ReturnType<typeof createBotGroupAttachmentUploadRegistry>;

  beforeAll(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-bot-group-remote-'));
    workerScriptPath = await buildDbWorkerBundle(path.join(rootDir, 'worker'));
    dbPath = path.join(rootDir, 'groups.db');
    drizzleDir = path.join(rootDir, 'drizzle');
    fs.mkdirSync(drizzleDir);
    fs.writeFileSync(path.join(drizzleDir, '0000_init.sql'), 'CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);', 'utf8');
    createMigratedSmokeDb(dbPath);
    seedSchema(dbPath);
    const options = { workerScriptPath, dbPath, drizzleDir, betterSqliteModulePath: require.resolve('better-sqlite3') };
    // SQLite initialization itself opens the schema/migration connection.
    // Establish peer A's readiness before opening peer B so this fixture does
    // not manufacture a startup lock race that production startup serializes.
    peerA = new WorkerThreadTransport(options);
    await peerA.send('query', { sql: 'SELECT 1' });
    peerB = new WorkerThreadTransport(options);
    await peerB.send('query', { sql: 'SELECT 1' });
    h.client = clientFor(peerA);
    service = createBotGroupChatService({
      ensureLane: async ({ botId }) => ({ ok: true as const, sessionId: 'lane-' + botId }),
      dispatch: async () => ({ ok: true as const, targetSessionId: 'lane', wakeKind: 'queued' }),
      abortLane: async () => undefined,
    });
    uploadRegistry = createBotGroupAttachmentUploadRegistry({
      presignPut: async (size, ext, contentType) => ({
        putUrl: `https://upload.invalid/${ext}/${size}`,
        key: `opaque-key/${ext}/${size}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      removeRemote: async () => undefined,
    });
    registerBotGroupRemoteResourceProvider(() => service, uploadRegistry);
  });

  beforeEach(async () => {
    await peerB.send('exec', { sql: 'DELETE FROM bot_groups' });
    await peerB.send('exec', { sql: "UPDATE bot_profiles SET status = 'active', hidden_at = NULL" });
  });

  afterAll(async () => {
    await Promise.all([peerA?.close(), peerB?.close()]);
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('uses the actual remote invoke, two peers and isolated SQLite groups', async () => {
    const first = await remoteResourceRegistry.invoke(context(), {
      client: remoteClient, collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, actionId: 'create',
      input: { name: '第一群', botIds: ['mimi', 'abu'], requestId: 'peer-a-create-0001' },
    });
    const second = await remoteResourceRegistry.invoke({ ...context(), controllerDeviceId: 'peer-b' }, {
      client: remoteClient, collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, actionId: 'create',
      input: { name: '第二群', botIds: ['mimi', 'xiaoman'], requestId: 'peer-b-create-0001' },
    });
    const firstId = (first.effects[1] as any).target.ref.id as string;
    const secondId = (second.effects[1] as any).target.ref.id as string;
    expect(firstId).not.toBe(secondId);
    await remoteResourceRegistry.invoke(context(), {
      client: remoteClient, collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, actionId: 'update',
      resourceRef: ref(firstId), input: { name: '第一群已更新' },
    });
    const rows = await peerB.send<Array<{ id: string; name: string }>>('query', { sql: 'SELECT id, name FROM bot_groups ORDER BY id' });
    expect(rows).toEqual(expect.arrayContaining([
      { id: firstId, name: '第一群已更新' }, { id: secondId, name: '第二群' },
    ]));
  });

  it('rejects a revision or hidden-member change made by the other peer after the remote snapshot', async () => {
    const created = await remoteResourceRegistry.invoke(context(), {
      client: remoteClient, collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, actionId: 'create',
      input: { name: '并发群', botIds: ['mimi', 'abu'], requestId: 'peer-a-create-revision-01' },
    });
    const groupId = (created.effects[1] as any).target.ref.id as string;
    const originalUpdate = service.updateGroup;
    service.updateGroup = async (input, options) => {
      await peerB.send('exec', { sql: 'UPDATE bot_groups SET updated_at = updated_at + 1 WHERE id = ?', params: [groupId] });
      return originalUpdate(input, options);
    };
    await expect(remoteResourceRegistry.invoke(context(), {
      client: remoteClient, collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, actionId: 'update', resourceRef: ref(groupId),
      input: { name: '不应覆盖更新' },
    })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    service.updateGroup = originalUpdate;
    await expect(peerB.send<Array<{ name: string }>>('query', {
      sql: 'SELECT name FROM bot_groups WHERE id = ?', params: [groupId],
    })).resolves.toEqual([{ name: '并发群' }]);

    const originalSetMembers = service.setMembers;
    service.setMembers = async (input, options) => {
      await peerB.send('exec', { sql: "UPDATE bot_profiles SET hidden_at = 99 WHERE id = 'abu'" });
      return originalSetMembers(input, options);
    };
    await expect(remoteResourceRegistry.invoke(context(), {
      client: remoteClient, collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, actionId: 'set-members', resourceRef: ref(groupId),
      input: { botIds: ['mimi', 'abu'] },
    })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    service.setMembers = originalSetMembers;
  });

  it('holds a guarded mutation behind the default 128 in-flight worker calls', async () => {
    const created = await remoteResourceRegistry.invoke(context(), {
      client: remoteClient, collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, actionId: 'create',
      input: { name: '屏障群', botIds: ['mimi', 'abu'], requestId: 'peer-a-create-barrier-01' },
    });
    const groupId = (created.effects[1] as any).target.ref.id as string;
    const originalUpdate = service.updateGroup;
    let inUpdate = false;
    let updateGuards = 0;
    let revokeNext = false;
    let revoked = false;
    const assertCurrent = () => {
      if (revokeNext) {
        revoked = true;
        throw new Error('peer revoked while mutation was queued');
      }
      if (inUpdate) {
        updateGuards += 1;
        if (updateGuards === 2) revokeNext = true;
      }
      if (revoked) throw new Error('peer revoked');
    };
    service.updateGroup = async (input, options) => {
      inUpdate = true;
      const blockers = Array.from({ length: 128 }, () => peerA.send('sleep', { ms: 120 }));
      try {
        return await originalUpdate(input, options);
      } finally {
        await Promise.all(blockers);
        inUpdate = false;
      }
    };
    await expect(remoteResourceRegistry.invoke(context(assertCurrent), {
      client: remoteClient, collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, actionId: 'update', resourceRef: ref(groupId),
      input: { name: '撤权后不应落盘' },
    })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    service.updateGroup = originalUpdate;
    expect(updateGuards).toBeGreaterThanOrEqual(2);
    await expect(peerB.send<Array<{ name: string }>>('query', {
      sql: 'SELECT name FROM bot_groups WHERE id = ?', params: [groupId],
    })).resolves.toEqual([{ name: '屏障群' }]);
    await expect(remoteResourceRegistry.invoke(context(), {
      client: remoteClient, collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, actionId: 'update', resourceRef: ref(groupId),
      input: { name: '撤权后的合法新操作' },
    })).resolves.toMatchObject({ effects: [{ kind: 'refresh-resource' }] });
  });

  it('exposes only the host-issued upload receipt through the real resource provider', async () => {
    const created = await remoteResourceRegistry.invoke(context(), {
      client: remoteClient, collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, actionId: 'create',
      input: { name: '上传授权群', botIds: ['mimi', 'abu'], requestId: 'peer-a-upload-01' },
    });
    const groupId = (created.effects[1] as any).target.ref.id as string;
    const input = {
      attachmentId: 'attachment-01', intent: 'send-intent-01', name: 'photo.png', size: 9,
      sha256: 'a'.repeat(64), mimeType: 'image/png', ext: 'png',
    };
    await expect(remoteResourceRegistry.invoke(context(), {
      client: remoteClient, collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, actionId: 'prepare-upload',
      resourceRef: ref(groupId), input: { ...input, key: 'raw-oss-key' },
    })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    const prepared = await remoteResourceRegistry.invoke(context(), {
      client: remoteClient, collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, actionId: 'prepare-upload',
      resourceRef: ref(groupId), input,
    });
    expect(prepared.data).toMatchObject({
      attachmentId: input.attachmentId, intent: input.intent, size: input.size, sha256: input.sha256,
    });
    expect(prepared.data).not.toHaveProperty('key');
    expect(prepared.data).not.toHaveProperty('presigned');
    const receipt = (prepared.data as { receipt: string }).receipt;
    const cancelInput = { receipt, attachmentId: input.attachmentId, intent: input.intent, size: input.size, sha256: input.sha256, mimeType: input.mimeType };
    await expect(remoteResourceRegistry.invoke({ ...context(), controllerDeviceId: 'peer-b' }, {
      client: remoteClient, collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, actionId: 'cancel-upload',
      resourceRef: ref(groupId), input: cancelInput,
    })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(uploadRegistry.size()).toBe(1);
    await expect(remoteResourceRegistry.invoke(context(), {
      client: remoteClient, collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, actionId: 'cancel-upload',
      resourceRef: ref(groupId), input: cancelInput,
    })).resolves.toMatchObject({ effects: [{ kind: 'refresh-resource' }] });
    expect(uploadRegistry.size()).toBe(0);
  });
});
