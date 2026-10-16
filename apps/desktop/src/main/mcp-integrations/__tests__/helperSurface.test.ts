import { expect, it, vi } from 'vitest';
import type { DbClient } from '../../localDb/client/DbClient.js';
import { resolveHelperSurface } from '../helperSurface.js';

it.each([undefined, { pluginOwned: 1 }, { pluginOwned: 0, retainedPlugin: 0 }])('resolves the ordinary surface without reviving a missing or retired task: %j', async (row) => {
  const queryOne = vi.fn(async (_sql: string, _params: unknown[]) => row);
  const db = { queryOne } as unknown as Pick<DbClient, 'queryOne' | 'drizzle'>;
  expect(await resolveHelperSurface(db, 'task', () => ({ executing: false, input: null }))).toBe(row && !row.pluginOwned ? 'default' : 'restricted');
  expect(queryOne).toHaveBeenCalledWith(expect.stringContaining('s.id NOT IN ('), ['task']);
  const sql = queryOne.mock.calls[0]?.[0];
  expect(sql).toContain('bot_session_links');
  expect(sql).toContain('bot_profiles');
  expect(sql).toContain('bot_delegations');
});
