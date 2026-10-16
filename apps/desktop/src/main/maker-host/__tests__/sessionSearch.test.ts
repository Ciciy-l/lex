import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ query: vi.fn(), assertAllowed: vi.fn() }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ query: state.query }) }));
vi.mock('../../localDb/retiredCompanions.js', async (original) => ({ ...await original<object>(), assertNotRetiredCompanionSession: state.assertAllowed }));
import { searchSessionsFn } from '../session-search.js';
beforeEach(() => { vi.clearAllMocks(); state.query.mockResolvedValue([]); state.assertAllowed.mockResolvedValue(undefined); });
it('filters every historical ownership form from ordinary FTS results without widening a selected task', async () => {
  await searchSessionsFn('release', { callerSessionId: 'ordinary', sessionId: 'selected' });
  expect(state.assertAllowed).toHaveBeenCalledWith('ordinary');
  const [sql, params] = state.query.mock.calls[0];
  expect(sql).toContain('m.session_id NOT IN (');
  for (const table of ['bot_session_links', 'bot_profiles', 'bot_delegations']) expect(sql).toContain(table);
  expect(sql).toContain('AND m.session_id = ?');
  expect(params).toEqual([16_384, '"release"', 'selected', 10]);
});
it('refuses a retired caller before searching account history', async () => {
  state.assertAllowed.mockRejectedValueOnce(new Error('[NOT_FOUND]'));
  await expect(searchSessionsFn('release', { callerSessionId: 'retired' })).rejects.toThrow('NOT_FOUND');
  expect(state.query).not.toHaveBeenCalled();
});
it('does not turn an old companion memory scope into account-wide search', async () => {
  expect(await searchSessionsFn('release', { callerMemoryScopeKey: 'bot:old' })).toEqual([]);
  expect(state.query).not.toHaveBeenCalled();
});
it('preserves the ordinary account query and parameters', async () => {
  await searchSessionsFn('release');
  expect(state.query.mock.calls[0][1]).toEqual([16_384, '"release"', 10]);
});
