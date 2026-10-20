import { describe, it, expect, vi } from 'vitest';
import type { AgentNativeStopResolver, AgentNativeStopRequest, Session } from '@cindy/maker-core';
import { bindNativeSessionStop } from '../nativeStopBinding.js';
function fixture() {
  let resolve!: AgentNativeStopResolver, current = true, turn: string | null = 'turn';
  const session = { id: 'task', sdkSessionId: 'native', getCurrentTurnId: () => turn,
    onNativeStop(fn: AgentNativeStopResolver) { resolve = fn; return () => {}; } } as Session;
  const stop = vi.fn(async (_session: Session, _request: AgentNativeStopRequest, _check: () => void) => { turn = null; });
  bindNativeSessionStop(session, { isCurrent: () => current, stop });
  return { session, stop, retire: () => { current = false; },
    run: (nativeTurnId = 'turn') => resolve({ nativeSessionId: 'native', nativeTurnId, signal: new AbortController().signal }) };
}
describe('Main native Stop binding', () => {
  it('uses the existing product stop immediately and allows its normal terminal state', async () => {
    const f = fixture(); await f.run(); expect(f.stop).toHaveBeenCalledOnce();
    expect(f.stop.mock.calls[0]?.[0]).toBe(f.session);
  });
  it('rejects obsolete turns and account changes without dispatching Stop', async () => {
    const f = fixture(); await expect(f.run('previous-turn')).rejects.toThrow('turn changed');
    f.retire(); await expect(f.run()).rejects.toThrow('no longer belongs'); expect(f.stop).not.toHaveBeenCalled();
  });
  it('propagates product persistence failures and rejects stale success', async () => {
    const f = fixture(); f.stop.mockRejectedValueOnce(new Error('goal write failed'));
    await expect(f.run()).rejects.toThrow('goal write failed');
    f.stop.mockImplementation(async () => { f.retire(); });
    await expect(f.run()).rejects.toThrow('no longer belongs');
  });
});
