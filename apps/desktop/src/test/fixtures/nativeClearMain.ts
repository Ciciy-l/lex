import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { createSourceFile, forEachChild, isCallExpression, isFunctionDeclaration, ScriptTarget, transpileModule, type Node } from 'typescript';
import { expect } from 'vitest';
import type { Session } from '@cindy/maker-core';
import type { DbClient } from '../../main/localDb/client/DbClient.js';
import { sessions } from '../../main/localDb/schema.js';
import { commitSessionContextClear } from '../../main/localDb/sessionContextClear.js';
import { InputClearReceipts } from '../../main/maker-ipc/inputClearReceipts.js';
import { withNativeHistoryClear } from '../../main/maker-ipc/nativeHistoryClear.js';
import { readNativeHistoryForClear } from '../../main/maker-ipc/nativeHistoryJournal.js';
import { createRehydrateCloseSuppression } from '../../main/maker-host/rehydrateCloseSuppression.js';

/** Compile only the production clear entry points; importing register itself
 * would initialize unrelated Electron/provider singletons in a SQLite test. */
export function productionClearFixture(client: DbClient, root: string, initial?: Session, hooks: { beforeClose?(): Promise<void>; beforePersist?(): Promise<void> } = {}) {
  const source = fs.readFileSync(path.resolve('src/main/maker-ipc/register.ts'), 'utf8');
  const ast = createSourceFile('register.ts', source, ScriptTarget.Latest, true);
  let capture = '', callback = '', readCallback = '';
  const visit = (node: Node) => {
    if (isFunctionDeclaration(node) && node.name?.text === 'captureNativeHistoryClearDependencies') capture = node.getText(ast);
    if (isCallExpression(node) && node.expression.getText(ast) === 'ipcMain.handle'
      && node.arguments[0]?.getText(ast) === 'MAKER_INVOKE.INPUT_CLEAR_SESSION') callback = node.arguments[1]!.getText(ast);
    if (isCallExpression(node) && node.expression.getText(ast) === 'ipcMain.handle'
      && node.arguments[0]?.getText(ast) === 'MAKER_INVOKE.INPUT_GET_PROJECTION') readCallback = node.arguments[1]!.getText(ast);
    forEachChild(node, visit);
  };
  visit(ast); expect(capture).not.toBe(''); expect(callback).not.toBe('');
  let current = initial, generation = 1;
  const receipts = new InputClearReceipts();
  const calls: string[] = [];
  const suppression = createRehydrateCloseSuppression({ debug() {}, warn() {} });
  const dependencies = {
    inputClearReceipts: receipts,
    withRehydrateCloseSuppressed: suppression.withSuppressed,
    getDbClient: () => client, getCurrentDbClientSnapshot: () => client,
    getActiveAppSession: () => ({ generation, dataOwnerId: 'isolated-owner' }), isAppSessionBoundaryPending: () => false,
    getMaker: () => ({ getSession: () => current, closeSessionIfCurrent: async (session: Session) => {
      expect(session).toBe(current); calls.push('close'); await hooks.beforeClose?.(); await session.close(); current = undefined;
      await suppression.runOnCloseSideEffects(session.id, async () => { calls.push('temp-and-worktree-cleanup'); });
    } }), ownerScopedUserDataPath: () => root, sessions, eq,
    throwIpcError: (code: string, message: string) => { throw new Error(code + ': ' + message); },
    requireSessionId: (id: string) => id, assertReviewExternalInputAllowed: async () => {}, isDeviceLinkInvoke: () => false,
    beginRemoteInputClearGate: () => calls.push('gate'), endRemoteInputClearGate: () => calls.push('ungate'),
    resolveClearSessionBoundary: ({ clearedAt }: { clearedAt: string }) => clearedAt,
    inputCoordinator: { clearSession: (sessionId: string) => { calls.push('queue'); return { sessionId, pendingQueue: [] }; },
      getProjection: (sessionId: string) => ({ sessionId, pendingQueue: [] }) },
    workingDirectoryRecovery: { discard() {} }, resetAutomaticRecoveryForExplicitStop() {},
    agentHandoffPending: { invalidate: () => calls.push('invalidate'), sealClearBoundary: () => calls.push('seal') },
    getAgentIslandService: () => undefined, goalClearObserver: undefined,
    clearSessionContextInDb: async (id: string, at: number, expected?: { nativeId: string | null; clearedAt: number | null }) => {
      calls.push('persist'); await hooks.beforePersist?.(); return commitSessionContextClear(client, id, at, expected);
    }, withNativeHistoryClear, readNativeHistoryForClear, log: { error() {} },
  };
  const code = transpileModule(capture + '\nreturn (' + callback + ');', { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
  const handler = new Function(...Object.keys(dependencies), code)(...Object.values(dependencies));
  const readCode = transpileModule(capture + String.fromCharCode(10) + 'return (' + readCallback + ');', { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
  const readHandler = new Function(...Object.keys(dependencies), readCode)(...Object.values(dependencies));
  return { calls, replaceExecutor: (next?: Session) => { current = next; },
    currentExecutor: () => current, receipts, changeOwner: () => { generation++; },
    read: (at = 500, id = 's1') => readHandler(undefined, id, { clearRequestAt: new Date(at).toISOString() }),
    clear: (at = 500, id = 's1') => handler(undefined, id, new Date(at).toISOString()) as Promise<unknown> };
}

