// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSessionTokens } from '../useSessionTokens';
import { getSessionFor } from '@/lib/makerTransport';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
vi.mock('@/lib/makerTransport', () => ({ getSessionFor: vi.fn() }));
const get = vi.mocked(getSessionFor);
type Push = Parameters<NonNullable<Window['electronAPI']['onUsageSessionTokensChanged']>>[0];
let push: Push;
const unsubscribe = vi.fn();
const subscribe = vi.fn((receive: Push) => { push = receive; return unsubscribe; });
beforeEach(() => {
  vi.clearAllMocks(); setDataOwnerGeneration('one', 1);
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { onUsageSessionTokensChanged: subscribe } });
});
afterEach(cleanup);
const session = (totalTokenUsage: number) => ({ totalTokenUsage } as Awaited<ReturnType<typeof getSessionFor>>);

it('restores completed usage after a view remount and subscribes before reading the ledger', async () => {
  get.mockResolvedValue(session(45));
  const first = renderHook(() => useSessionTokens('task', null));
  await waitFor(() => expect(first.result.current).toBe(45)); first.unmount();
  const next = renderHook(() => useSessionTokens('task', null));
  await waitFor(() => expect(next.result.current).toBe(45));
  expect(subscribe.mock.invocationCallOrder[0]).toBeLessThan(get.mock.invocationCallOrder[0]);
  expect(unsubscribe).toHaveBeenCalledOnce();
});
it('keeps a live cumulative value ahead of a delayed read and stale same-task props', async () => {
  let resolve!: (value: Awaited<ReturnType<typeof getSessionFor>>) => void;
  get.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const ui = renderHook(({ initial }) => useSessionTokens('task', initial), { initialProps: { initial: 0 } });
  act(() => push({ sessionId: 'task', totalTokens: 60 }));
  await act(async () => resolve(session(45))); ui.rerender({ initial: 15 });
  expect(ui.result.current).toBe(60);
});
it('ignores old task reads after navigation and unsubscribes on unmount', async () => {
  let resolve!: (value: Awaited<ReturnType<typeof getSessionFor>>) => void;
  get.mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValue(session(90));
  const ui = renderHook(({ id }) => useSessionTokens(id, null), { initialProps: { id: 'old-task' } });
  ui.rerender({ id: 'new-task' });
  await waitFor(() => expect(ui.result.current).toBe(90));
  await act(async () => resolve(session(999))); expect(ui.result.current).toBe(90);
  ui.unmount(); expect(unsubscribe).toHaveBeenCalledTimes(2);
});
it('does not apply old-owner reads or pushes after an account generation changes', async () => {
  let resolve!: (value: Awaited<ReturnType<typeof getSessionFor>>) => void;
  get.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const ui = renderHook(() => useSessionTokens('task', null));
  setDataOwnerGeneration('two', 2);
  act(() => push({ sessionId: 'task', totalTokens: 999 }, { dataOwnerId: 'one', ownerGeneration: 1 }));
  await act(async () => resolve(session(999))); expect(ui.result.current).toBeNull();
});
