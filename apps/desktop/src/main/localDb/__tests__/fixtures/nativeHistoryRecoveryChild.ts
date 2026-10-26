import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Session } from '../../../../../../../packages/maker-core/src/session.js';
import type { AgentSessionHandle } from '@cindy/maker-core';
import { WorkerThreadTransport } from '../../client/WorkerThreadTransport.js';
import { createNativeHistoryHandoff } from '../../../maker-ipc/nativeHistoryHandoff.js';
import { nativeHistoryConfiguration, nativeHistoryStartupTarget } from '../../../maker-ipc/nativeHistoryJournal.js';

// A separate Host process and real SQLite worker. Only the native executor is
// synthetic here; the real native fork fixtures exercise that boundary separately.
async function main() {
  const [mode, configPath] = process.argv.slice(2);
  assert.ok(mode === 'mutate' || mode === 'recover');
  const config = JSON.parse(await fs.readFile(configPath!, 'utf8'));
  const transport = new WorkerThreadTransport({ ...config, userId: 'test-user' });
  const root = path.dirname(config.dbPath), journalRoot = path.join(root, 'handoff');
  const source = path.join(root, 'source.jsonl'), target = path.join(root, 'target.jsonl');
  const nativeStateFile = path.join(root, 'native-state.json');
  const identity = { sessionId: 's1', nativeId: source, agentKind: 'pi', workingDir: root, model: 'exact-model',
    configuration: nativeHistoryConfiguration({ providerId: 'synthetic-route', effort: 'high', permissionMode: 'ask' }) };
  const startup = nativeHistoryStartupTarget(journalRoot, identity);
  let nativeId = startup.target, editor = mode === 'mutate' ? 'unsent TUI draft' : '';
  let sends = 0, navigations = 0, reads = 0;
  const state = { tree: { roots: [], leafId: 'actual', activePathIds: [] }, messages: [], contextTokens: 17, contextWindow: 100 };
  const handle: AgentSessionHandle = {
    get id() { return nativeId; }, agentKind: 'pi', model: 'exact-model',
    async send() { sends++; throw new Error('Unexpected prompt replay'); }, async steer() { throw new Error('Unexpected steer'); },
    async abort() {}, async close() {}, events: async function* () {}, setInteractionResolver() {}, isTurnRunning: () => false,
    getUsageSnapshot: () => ({ tokenUsage: 234, contextTokens: 17, contextWindow: 100, costUsd: 0.12 }),
    async readNativeEditorDraft() { return editor; }, async restoreNativeEditorDraft(value) { editor = value; },
    async navigateSessionTree(_entry, _options, handoff) {
      assert.equal(mode, 'mutate'); navigations++;
      await handoff!.beforeReplacement();
      await fs.writeFile(nativeStateFile, JSON.stringify({ mutations: 1, nativeId: target }));
      await handoff!.target(target); nativeId = target;
      return { ...state, draftText: 'selected GUI draft' };
    },
    async readSessionTree() {
      reads++;
      const native = JSON.parse(await fs.readFile(nativeStateFile, 'utf8'));
      assert.equal(native.nativeId, nativeId); assert.equal(native.mutations, 1);
      return state;
    },
  };
  const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };
  const session = new Session({ id: 's1', agentKind: 'pi', workDir: root, handle, logger, turnStallMs: 0,
    capabilities: { sessionTree: { supported: true } } as never });
  try {
    const controller = createNativeHistoryHandoff({ root: journalRoot, session, configuration: () => identity.configuration,
      // Parent launches these children sequentially; lock contention is covered
      // separately with the production cross-process lock.
      exclusive: operation => operation(),
      assertCurrent() {}, async persist(result) {
        return transport.send('tx', { name: 'session.treeRehydrate', args: { sessionId: 's1', now: 1000, contextTokens: result.contextTokens,
          contextWindow: result.contextWindow, nativeIdentity: result.nativeIdentity,
          messages: [{ id: 'branch-row', clientId: 'branch-row', role: 'user', content: '{}', agentKind: 'pi', createdAt: 1 }] } });
      },
    });
    if (mode === 'mutate') {
      await assert.rejects(controller.navigate('chosen', {}), /injected projection failure/);
      assert.equal(navigations, 1); assert.equal(controller.pending, true); assert.equal(session.isTurnRunning(), true);
      await assert.rejects(session.send('must stay frozen'));
    } else {
      assert.equal(startup.target, target); assert.equal(session.isTurnRunning(), true);
      await assert.rejects(session.send('must stay frozen'));
      const recovered = await controller.recover();
      assert.equal(recovered?.result.draftText, 'selected GUI draft');
      assert.equal(editor, 'unsent TUI draft'); assert.equal(reads, 1); assert.equal(navigations, 0);
      assert.equal(session.isTurnRunning(), false); assert.equal(controller.pending, false);
      assert.equal(await controller.recover(), null);
    }
    assert.equal(sends, 0); assert.equal(session.getUsageSnapshot().tokenUsage, 234);
    console.log(JSON.stringify({ mode, pid: process.pid, navigations, reads, sends, nativeId, editor, usage: session.getUsageSnapshot() }));
  } finally { await session.close(); await transport.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
