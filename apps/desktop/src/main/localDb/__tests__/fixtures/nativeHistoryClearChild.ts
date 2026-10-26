import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WorkerThreadTransport } from '../../client/WorkerThreadTransport.js';
import { finishCommittedNativeHistoryClear } from '../../../maker-ipc/nativeHistoryClear.js';
import { createNativeHistoryJournal } from '../../../maker-ipc/nativeHistoryJournal.js';

// New Host process, same isolated SQLite and journal; no native executor is
// started. Only a previously confirmed exit + committed clear may retire it.
async function main() {
  const config = JSON.parse(await fs.readFile(process.argv[2]!, 'utf8'));
  const transport = new WorkerThreadTransport(config);
  const root = path.dirname(config.dbPath), journalRoot = path.join(root, 'clear-journal');
  try {
    const retired = await finishCommittedNativeHistoryClear({ root: journalRoot, sessionId: 's1', assertCurrent() {},
      readState: async () => (await transport.send('queryOne', {
        sql: 'SELECT sdk_session_id AS nativeId, cleared_at AS clearedAt FROM sessions WHERE id = ?', params: ['s1'],
      })) as { nativeId: string | null; clearedAt: number | null },
    });
    assert.equal(retired, true);
    assert.equal(createNativeHistoryJournal(journalRoot, { sessionId: 's1', nativeId: path.join(root, 'new.jsonl'),
      agentKind: 'pi', workingDir: root, model: 'exact-model' }).read(), null);
    assert.deepEqual(await transport.send('query', { sql: 'SELECT id FROM messages WHERE session_id = ?', params: ['s1'] }), []);
    console.log(JSON.stringify({ retired, newIdentityAllowed: true, executorStarts: 0 }));
  } finally { await transport.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
