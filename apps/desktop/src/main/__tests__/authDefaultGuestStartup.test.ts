import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError, parseAuthSessionRecord, serializeAuthSessionRecord } from '@cindy/auth-client';

// Execute the production initialization and safe-storage helpers without
// importing Electron or reading a real profile. Only owner commit/network
// boundaries are doubles; credential files live in unique synthetic temp dirs.
const source = fs.readFileSync(path.resolve(process.cwd(), 'src/main/authManager.ts'), 'utf8');
const ast = ts.createSourceFile('authManager.ts', source, ts.ScriptTarget.ES2022, true);
const names = new Set([
  'initialize', 'readSafe', 'isPersistedSecretAbsent', 'writeSafe',
  'readPersistedAuthSession', 'reconcileDesktopActiveAuthSession',
  'writePersistedAuthSession', 'writePersistedAuthSessionOrThrow',
  'recoverAccountFreeOwnerAtStartup', 'finishColdStartSignedOut',
]);
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node)
  && node.name && names.has(node.name.text)).map(node => node.getText(ast).replace(/^export /, ''));
if (functions.length !== names.size) throw new Error('Startup harness is missing a production function');
const compiled = ts.transpileModule(functions.join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

type Mode = 'signed-out' | 'local' | 'cloud';
interface StartupSnapshot { mode: Mode; isAuthenticated: boolean; ownerBoundaryPending?: boolean }
interface Faults {
  key?: string;
  migrationWrite?: boolean;
  read?: boolean;
  access?: boolean;
  decrypt?: boolean;
  encryption?: boolean;
  vault?: boolean;
}
const SESSION = 'fixture-auth-session-v1';
const LEGACY = 'fixture-legacy-resource';
const FAKE_TOKEN = 'synthetic-token-never-valid';
const tempDirectories: string[] = [];

function directory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-auth-default-guest-'));
  tempDirectories.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempDirectories.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir())
      || !path.basename(root).startsWith('lex-auth-default-guest-')) {
      throw new Error('Refusing to clean outside the synthetic test directory');
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function harness(root: string, faults: Faults = {}, options: { passive?: boolean; ownerPending?: boolean } = {}) {
  const safeDir = path.join(root, 'safe-storage');
  const sessionFile = path.join(root, 'synthetic-app-session.json');
  let mode: Mode = fs.existsSync(sessionFile)
    ? JSON.parse(fs.readFileSync(sessionFile, 'utf8')).mode
    : 'signed-out';
  const commit = (next: Mode) => {
    mode = next;
    fs.writeFileSync(sessionFile, JSON.stringify({ mode }));
  };
  const snapshot = (): StartupSnapshot => ({ mode, isAuthenticated: mode === 'cloud' });
  const fileOf = (key: string) => path.join(safeDir, key + '.enc');
  const isFaultFile = (file: string) => file === fileOf(faults.key ?? SESSION);
  const unavailable = () => Object.assign(new Error('Synthetic credential access unavailable'), { code: 'EACCES' });
  const io = {
    constants: fs.constants,
    existsSync: (file: string) => !(faults.access && isFaultFile(file)) && fs.existsSync(file),
    accessSync: (file: string, access: number) => {
      if (faults.access && isFaultFile(file)) throw unavailable();
      fs.accessSync(file, access);
    },
    readFileSync: (file: string, encoding: BufferEncoding) => {
      if (faults.read && isFaultFile(file)) throw unavailable();
      return fs.readFileSync(file, encoding);
    },
    mkdirSync: fs.mkdirSync,
    writeFileSync: (file: string, data: string, encoding: BufferEncoding) => {
      if (faults.migrationWrite && file === fileOf(SESSION)) throw unavailable();
      fs.writeFileSync(file, data, encoding);
    },
  };
  const safeStorage = {
    isEncryptionAvailable: vi.fn(() => !faults.encryption),
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: vi.fn((value: Buffer) => {
      if (faults.decrypt) throw new Error('Synthetic decryption failure');
      return value.toString('utf8');
    }),
  };
  const recoverOwner = vi.fn(async ({ nextMode }: { nextMode: Mode }) => commit(nextMode));
  const refresh = vi.fn(async (_token: string, _realm: string) => {
    commit('cloud');
    return snapshot();
  });
  const loadEndpoints = vi.fn(async (_realm: string) => undefined);
  const mirror = vi.fn();
  const dependencies = {
    fs: io, path, Buffer, safeStorage, AuthApiError, parseAuthSessionRecord, serializeAuthSessionRecord,
    SAFE_STORAGE_DIR: () => safeDir,
    AUTH_SESSION_KEY: SESSION, LEGACY_RESOURCE_REFRESH_TOKEN_KEY: LEGACY,
    LEGACY_ACCOUNT_REFRESH_TOKEN_KEY: 'fixture-old-account', LEGACY_REFRESH_TOKEN_KEY: 'fixture-old-feishu',
    AUTH_REGION: 'global', activeAuthRealm: 'global', LOCAL_DATA_OWNER_ID: 'local-v1',
    COLD_START_AUTH_GATE_TIMEOUT_MS: 100,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, logSafeStorageIssueOnce: vi.fn(),
    isOwnerChangeShellPending: () => options.ownerPending ?? false,
    getActiveAppSession: () => ({ mode, dataOwnerId: mode === 'local' ? 'local-v1' : null }),
    isPassiveSharedUserDataInstance: () => options.passive ?? false,
    isGhostSkillProjectionBoundaryStableForOwner: () => false,
    withAccountFreeOwnerCommit: recoverOwner,
    commitActiveAppSession: commit, commitVolatileAppSession: (next: Mode) => { mode = next; },
    snapshotAuthState: snapshot,
    snapshotLoggedOutAuthState: (pending = false) => ({ mode, isAuthenticated: false, ownerBoundaryPending: pending }),
    readReloginFlag: () => null,
    removeSafe: (key: string) => { if (fs.existsSync(fileOf(key))) fs.unlinkSync(fileOf(key)); },
    withCrossProcessLock: async (_file: string, _options: unknown, run: (status: { held: boolean }) => unknown) => run({ held: true }),
    authAccountVaultLockPath: () => path.join(root, 'synthetic-vault.lock'),
    readAuthAccountVault: () => {
      if (faults.vault) throw unavailable();
      return { activeAccountKey: null, resources: {} };
    },
    mirrorLegacyResourceRefreshToken: mirror,
    loadClientEndpointsForRealm: loadEndpoints,
    runColdStartRefreshFlow: refresh,
    awaitWithStartupTimeout: (completion: Promise<StartupSnapshot>) => completion,
  };
  const createInitialize = new Function('deps',
    'const {' + Object.keys(dependencies).join(',') + '} = deps;'
    + 'let accessToken=null,currentUser=null,lastAcceptedRefreshToken=null,pendingAccountToken=null;'
    + 'let passiveLocalSignOut=false,foreignDeviceLocalSignOut=false,coldStartAuthInFlight=null;'
    + compiled + '\nreturn initialize;') as (deps: typeof dependencies) => () => Promise<StartupSnapshot>;
  return {
    initialize: createInitialize(dependencies), recoverOwner, refresh, loadEndpoints, safeStorage, mirror,
    savedMode: () => JSON.parse(fs.readFileSync(sessionFile, 'utf8')).mode as Mode,
    put: (key: string, value: string) => {
      fs.mkdirSync(safeDir, { recursive: true });
      fs.writeFileSync(fileOf(key), Buffer.from(value).toString('base64'));
    },
    bytes: (key: string) => fs.readFileSync(fileOf(key)),
    has: (key: string) => fs.existsSync(fileOf(key)),
    commit,
  };
}

describe('default guest startup requires confirmed credential absence', () => {
  it('opens a genuinely empty profile as the real local owner', async () => {
    const runtime = harness(directory());
    expect(await runtime.initialize()).toMatchObject({ mode: 'local', isAuthenticated: false });
    expect(runtime.savedMode()).toBe('local');
    expect(runtime.refresh).not.toHaveBeenCalled();
  });

  it('keeps a failed legacy migration retryable across a new process', async () => {
    const root = directory();
    const runtime = harness(root, { migrationWrite: true });
    runtime.put(LEGACY, FAKE_TOKEN);
    const original = runtime.bytes(LEGACY);
    expect(await runtime.initialize()).toMatchObject({ mode: 'signed-out', isAuthenticated: false });
    expect(runtime.savedMode()).toBe('signed-out');
    expect(runtime.bytes(LEGACY)).toEqual(original);
    expect(runtime.mirror).not.toHaveBeenCalled();
    expect(runtime.refresh).not.toHaveBeenCalled();

    const restarted = harness(root);
    expect(await restarted.initialize()).toMatchObject({ mode: 'cloud', isAuthenticated: true });
    expect(restarted.refresh).toHaveBeenCalledExactlyOnceWith(FAKE_TOKEN, 'global');
    expect(restarted.recoverOwner).not.toHaveBeenCalled();
  });

  it.each([SESSION, LEGACY])('does not turn unreadable %s into durable guest selection', async (key) => {
    const root = directory();
    const runtime = harness(root, { key, read: true });
    runtime.put(key, key === SESSION ? serializeAuthSessionRecord('global', FAKE_TOKEN) : FAKE_TOKEN);
    const original = runtime.bytes(key);
    expect(await runtime.initialize()).toMatchObject({ mode: 'signed-out' });
    expect(runtime.savedMode()).toBe('signed-out');
    expect(runtime.bytes(key)).toEqual(original);
    expect(runtime.refresh).not.toHaveBeenCalled();
    expect((await harness(root).initialize()).mode).toBe('cloud');
  });

  it.each([SESSION, LEGACY])('preserves %s after a decryption failure', async (key) => {
    const runtime = harness(directory(), { key, decrypt: true });
    runtime.put(key, key === SESSION ? serializeAuthSessionRecord('global', FAKE_TOKEN) : FAKE_TOKEN);
    const original = runtime.bytes(key);
    expect((await runtime.initialize()).mode).toBe('signed-out');
    expect(runtime.savedMode()).toBe('signed-out');
    expect(runtime.bytes(key)).toEqual(original);
    expect(runtime.refresh).not.toHaveBeenCalled();
  });

  it('does not treat an access error hidden by existsSync as an absent credential', async () => {
    const runtime = harness(directory(), { key: LEGACY, access: true });
    runtime.put(LEGACY, FAKE_TOKEN);
    expect((await runtime.initialize()).mode).toBe('signed-out');
    expect(runtime.savedMode()).toBe('signed-out');
    expect(runtime.has(LEGACY)).toBe(true);
    expect(runtime.refresh).not.toHaveBeenCalled();
  });

  it('retains recovery when encryption is unavailable or a session is malformed', async () => {
    const unavailable = harness(directory(), { encryption: true });
    expect((await unavailable.initialize()).mode).toBe('signed-out');
    expect(unavailable.savedMode()).toBe('signed-out');
    const malformed = harness(directory());
    malformed.put(SESSION, 'synthetic-invalid-session-json');
    expect((await malformed.initialize()).mode).toBe('signed-out');
    expect(malformed.has(SESSION)).toBe(true);
  });

  it('restores a valid saved cloud session through the original refresh path', async () => {
    const runtime = harness(directory());
    runtime.put(SESSION, serializeAuthSessionRecord('global', FAKE_TOKEN));
    expect((await runtime.initialize()).mode).toBe('cloud');
    expect(runtime.loadEndpoints).toHaveBeenCalledExactlyOnceWith('global');
    expect(runtime.refresh).toHaveBeenCalledExactlyOnceWith(FAKE_TOKEN, 'global');
    expect(runtime.recoverOwner).not.toHaveBeenCalled();
  });

  it('keeps a previously chosen local owner ahead of unreadable saved credentials', async () => {
    const runtime = harness(directory(), { decrypt: true });
    runtime.put(SESSION, serializeAuthSessionRecord('global', FAKE_TOKEN));
    runtime.commit('local');
    expect((await runtime.initialize()).mode).toBe('local');
    expect(runtime.safeStorage.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(runtime.refresh).not.toHaveBeenCalled();
  });

  it('does not migrate the primary legacy token from a passive instance', async () => {
    const runtime = harness(directory(), {}, { passive: true });
    runtime.put(LEGACY, FAKE_TOKEN);
    expect((await runtime.initialize()).mode).toBe('signed-out');
    expect(runtime.has(SESSION)).toBe(false);
    expect(runtime.has(LEGACY)).toBe(true);
    expect(runtime.recoverOwner).not.toHaveBeenCalled();
    expect(runtime.refresh).not.toHaveBeenCalled();
  });

  it('keeps owner-pending and unreadable-vault recovery outside the new guest default', async () => {
    const pending = harness(directory(), {}, { ownerPending: true });
    expect(await pending.initialize()).toMatchObject({ mode: 'signed-out', ownerBoundaryPending: true });
    expect(pending.recoverOwner).not.toHaveBeenCalled();
    const unavailable = harness(directory(), { vault: true });
    expect((await unavailable.initialize()).mode).toBe('signed-out');
    expect(unavailable.savedMode()).toBe('signed-out');
    expect(unavailable.refresh).not.toHaveBeenCalled();
  });
});
