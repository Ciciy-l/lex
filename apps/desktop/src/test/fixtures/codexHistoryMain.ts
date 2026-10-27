import fs from 'node:fs';
import path from 'node:path';
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript';
import type { Session, CreateSessionOptions } from '@cindy/maker-core';
import type { DbClient } from '../../main/localDb/client/DbClient.js';
import { prepareCodexHistoryHandoff, createCodexHistoryDatabase } from '../../main/maker-ipc/codexHistoryHandoff.js';
import { finishCommittedNativeHistoryClear } from '../../main/maker-ipc/nativeHistoryClear.js';
import { nativeHistoryConfiguration } from '../../main/maker-ipc/nativeHistoryJournal.js';

/** Actual Main prepare body with its owner/service boundary supplied by this
 * fixture. Session, journal and SQLite remain in the chain; this is not an
 * Electron or native executor test. */
export function productionCodexHistoryFixture(client: DbClient, root: string) {
  const source = fs.readFileSync(path.resolve('src/main/maker-ipc/register.ts'), 'utf8');
  const ast = createSourceFile('register.ts', source, ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => isFunctionDeclaration(node) && node.name?.text === 'prepareCodexHistoryStart');
  if (!declaration) throw new Error('Production Codex history entry was not found');
  let current: Session | undefined, generation = 1, closes = 0;
  const dependencies = {
    getDbClient: () => client, getCurrentDbClientSnapshot: () => client,
    getActiveAppSession: () => ({ generation, dataOwnerId: 'isolated-owner' }), isAppSessionBoundaryPending: () => false,
    getMaker: () => ({ getSession: () => current, closeSessionIfCurrent: async (session: Session) => {
      if (session !== current) throw new Error('Executor changed');
      closes++; await session.close(); if (current === session) current = undefined;
    } }),
    ownerScopedUserDataPath: () => root, createCodexHistoryDatabase, prepareCodexHistoryHandoff, finishCommittedNativeHistoryClear,
    withRehydrateCloseSuppressed: (_id: string, action: () => Promise<unknown>) => action(),
    nativeHistoryConfigurationForSession: nativeHistoryConfiguration,
    captureNativeHistoryClearDependencies: (sessionId: string) => ({ root, sessionId, assertCurrent() {},
      readState: async () => {
        const row = await client.queryOne<{ nativeId: string | null; clearedAt: number | null }>(
          'SELECT sdk_session_id AS nativeId, cleared_at AS clearedAt FROM sessions WHERE id = ?', [sessionId]);
        if (!row) throw new Error('Task removed'); return row;
      } }),
  };
  const body = declaration.getText(ast).replace(/^export\s+/, '') + '\nreturn prepareCodexHistoryStart;';
  const code = transpileModule(body, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
  const prepare = new Function(...Object.keys(dependencies), code)(...Object.values(dependencies)) as
    (sessionId: string, start: CreateSessionOptions) => Promise<void>;
  return { prepare, setSession: (session?: Session) => { current = session; },
    changeOwner: () => { generation++; }, closes: () => closes };
}
