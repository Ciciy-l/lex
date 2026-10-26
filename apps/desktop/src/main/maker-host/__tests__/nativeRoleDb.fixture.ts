import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { ScriptTarget, transpileModule } from 'typescript';
import { createDbClient } from '../../localDb/client/DbClient.js';
import { sessions } from '../../localDb/schema.js';
import { buildDbWorkerBundle, createMigratedSmokeDb } from '../../localDb/__tests__/dbWorkerTestUtils.js';

/** Real worker-backed SQLite and the production Main role-clear functions,
 * without loading Electron's application/owner singletons into a native fixture. */
export async function nativeRoleDb(root: string, getSession: () => unknown, warn: (...args: unknown[]) => void) {
  const drizzleDir = path.join(root, 'drizzle');
  await mkdir(drizzleDir);
  await writeFile(path.join(drizzleDir, '0000_init.sql'), 'SELECT 1;');
  const dbPath = path.join(root, 'roles.db');
  createMigratedSmokeDb(dbPath);
  const workerScriptPath = await buildDbWorkerBundle(path.join(root, 'worker'));
  const db = await createDbClient({ dbPath, drizzleDir, userId: 'synthetic-role-owner', workerScriptPath,
    betterSqliteModulePath: require.resolve('better-sqlite3') });
  try {
    await db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, orca_role TEXT)');
    await db.exec("INSERT INTO sessions (id, orca_role) VALUES ('fixture-task', NULL)");
    const load = (file: string, start: string, end: string, name: string, deps: Record<string, unknown>) => {
      const source = readFileSync(path.resolve(file), 'utf8').replace(/\r\n?/g, '\n');
      const from = source.indexOf(start), to = source.indexOf(end, from);
      if (from < 0 || to <= from) throw new Error('Production role fixture boundary changed');
      const js = transpileModule(source.slice(from, to).replace(/^export /, ''), {
        compilerOptions: { target: ScriptTarget.ES2022 },
      }).outputText;
      return new Function(...Object.keys(deps), js + '; return ' + name)(...Object.values(deps));
    };
    const setRole = load('src/main/localDb/orcaTeamStore.ts', 'export async function setSessionOrcaRole(',
      '\nasync function getTeamById', 'setSessionOrcaRole', { getDbClient: () => db, sessions, eq, broadcastSessionPatch() {} }) as
      (id: string, role: 'lead' | 'worker' | null) => Promise<void>;
    const clear = load('src/main/maker-ipc/register.ts', '  async function clearLeadOrcaRoleState(',
      '\n  /**', 'clearLeadOrcaRoleState', { setSessionOrcaRole: setRole, knownNonOrcaSessionIds: new Set(),
        maker: { getSession }, log: { warn } }) as (id: string) => Promise<void>;
    return { db, setRole, clear, async role() {
      return (await db.queryOne<{ orca_role: string | null }>('SELECT orca_role FROM sessions WHERE id = ?', ['fixture-task']))!.orca_role;
    } };
  } catch (error) { await db.dispose(); throw error; }
}
