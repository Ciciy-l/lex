// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAgentPresentation } from '../useAgentPresentation';

const invoke = vi.fn();
beforeEach(() => {
  localStorage.clear(); invoke.mockReset();
  window.electronAPI = { maker: { presentation: invoke }, deviceLink: { invoke } } as any;
});
afterEach(cleanup);
const args = { sessionId: 'task', deviceId: null, ownerId: 'owner', enabled: true, runtimeKey: 'idle' };
const available = (generation: string) => ({ supported: true, state: { generation, status: 'running' } });

it('retains the chosen mode while rebinding the view to a new task runtime generation', async () => {
  invoke.mockResolvedValue(available('first'));
  const ui = renderHook(useAgentPresentation, { initialProps: args });
  await waitFor(() => expect(ui.result.current.generation).toBe('first'));
  act(() => ui.result.current.change('tui'));
  invoke.mockResolvedValue(available('next'));
  ui.rerender({ ...args, runtimeKey: 'running' });
  await waitFor(() => expect(ui.result.current.generation).toBe('next'));
  expect(ui.result.current.mode).toBe('tui');
  expect(invoke.mock.calls.every(([request]) => request.action === 'status')).toBe(true);
});

it('ignores a late capability result from the old account and keeps preferences separate', async () => {
  let resolve!: (value: unknown) => void;
  invoke.mockReturnValueOnce(new Promise(r => { resolve = r; })).mockResolvedValue(available('new-owner'));
  const ui = renderHook(useAgentPresentation, { initialProps: args });
  act(() => ui.result.current.change('tui'));
  ui.rerender({ ...args, ownerId: 'other' });
  await waitFor(() => expect(ui.result.current.generation).toBe('new-owner'));
  await act(async () => { resolve(available('stale')); });
  expect(ui.result.current.generation).toBe('new-owner');
  expect(ui.result.current.mode).toBe('gui');
});

it('falls back to GUI for an old host or closed runtime without discarding the TUI preference', async () => {
  invoke.mockResolvedValue(available('first'));
  const ui = renderHook(useAgentPresentation, { initialProps: args });
  await waitFor(() => expect(ui.result.current.supported).toBe(true));
  act(() => ui.result.current.change('tui'));
  invoke.mockRejectedValue(new Error('unknown channel'));
  ui.rerender({ ...args, runtimeKey: 'disconnected' });
  await waitFor(() => expect(ui.result.current.mode).toBe('gui'));
  invoke.mockResolvedValue({ supported: true, state: { generation: 'closed', status: 'closed' } });
  ui.rerender({ ...args, runtimeKey: 'closed' });
  await act(async () => {});
  expect(ui.result.current.supported).toBe(false);
  invoke.mockResolvedValue(available('reconnected'));
  ui.rerender({ ...args, runtimeKey: 'reconnected' });
  await waitFor(() => expect(ui.result.current.mode).toBe('tui'));
});
