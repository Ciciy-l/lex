import { expect, it, vi } from 'vitest';
import { handleRoutineRequest } from '../routineSlot.js';

it.each(['publish', 'status', 'list', 'run', 'delete'])('rejects retired routine %s without loading or mutating the old service', async (action) => {
  const getEngine = vi.fn();
  expect(await handleRoutineRequest({ enabled: true }, { action }, getEngine, () => true)).toEqual({
    ok: false, message: 'Routine service is unavailable',
  });
  expect(getEngine).not.toHaveBeenCalled();
});
