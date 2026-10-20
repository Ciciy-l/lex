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

it('shows the current host unavailability reason in GUI and drops it across account and device scopes', async () => {
  invoke.mockResolvedValue({ supported: false, reason: 'unsupported-service' });
  const ui = renderHook(useAgentPresentation, { initialProps: { ...args, deviceId: null as string | null } });
  await waitFor(() => expect(ui.result.current.unavailableReason).toBe('unsupported-service'));
  expect(ui.result.current.mode).toBe('gui');
  let complete!: (value: unknown) => void;
  invoke.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  ui.rerender({ ...args, ownerId: 'other', deviceId: 'remote' });
  expect(ui.result.current.unavailableReason).toBeUndefined();
  await act(async () => { complete({ supported: false }); });
  expect(ui.result.current.unavailableReason).toBeUndefined();
  expect(ui.result.current.supported).toBe(false);
});

it('creates an unnamed task only on explicit TUI selection and reuses it on later switches', async () => {
  invoke.mockResolvedValue({ supported: false });
  let release!: () => void;
  const prepare = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const ui = renderHook(useAgentPresentation, { initialProps: { ...args, prepare } });
  await waitFor(() => expect(invoke).toHaveBeenCalledOnce());
  expect(prepare).not.toHaveBeenCalled(); expect(ui.result.current.selectable).toBe(true);
  act(() => { ui.result.current.change('tui'); ui.result.current.change('tui'); });
  await waitFor(() => expect(prepare).toHaveBeenCalledOnce());
  expect(ui.result.current.mode).toBe('gui');
  invoke.mockResolvedValue(available('same-task'));
  await act(async () => { release(); });
  await waitFor(() => expect(ui.result.current.mode).toBe('tui'));
  act(() => { ui.result.current.change('gui'); ui.result.current.change('tui'); });
  expect(prepare).toHaveBeenCalledOnce(); expect(ui.result.current.generation).toBe('same-task');
});

it('keeps GUI available when explicit task startup fails', async () => {
  invoke.mockResolvedValue({ supported: false });
  const prepare = vi.fn(async () => { throw new Error('original startup error'); });
  const ui = renderHook(useAgentPresentation, { initialProps: { ...args, prepare } });
  act(() => ui.result.current.change('tui'));
  await waitFor(() => expect(ui.result.current.unavailableReason).toBe('startup-failed'));
  expect(ui.result.current.mode).toBe('gui'); expect(prepare).toHaveBeenCalledOnce();
});

it('keeps a busy legacy task in GUI and permits one explicit retry after its response ends', async () => {
  invoke.mockResolvedValue({ supported: false });
  const prepare = vi.fn().mockRejectedValueOnce(new Error('[SESSION_RUNNING] input still active'))
    .mockImplementationOnce(async () => { invoke.mockResolvedValue(available('resumed-original-task')); });
  const ui = renderHook(useAgentPresentation, { initialProps: { ...args, prepare } });
  act(() => ui.result.current.change('tui'));
  await waitFor(() => expect(ui.result.current.unavailableReason).toBe('task-busy'));
  expect(ui.result.current.mode).toBe('gui'); expect(prepare).toHaveBeenCalledOnce();
  act(() => ui.result.current.change('tui'));
  await waitFor(() => expect(ui.result.current.mode).toBe('tui'));
  expect(ui.result.current.generation).toBe('resumed-original-task'); expect(prepare).toHaveBeenCalledTimes(2);
});

it('consumes a routed TUI selection once after task hydration, without a message or a second startup', async () => {
  invoke.mockResolvedValue({ supported: false });
  const prepare = vi.fn(async () => { invoke.mockResolvedValue(available('routed-task')); });
  const ui = renderHook(useAgentPresentation, { initialProps: {
    ...args, enabled: false, initialMode: 'tui' as const, prepare,
  } });
  expect(prepare).not.toHaveBeenCalled();
  ui.rerender({ ...args, enabled: true, initialMode: 'tui', prepare });
  await waitFor(() => expect(ui.result.current.mode).toBe('tui'));
  act(() => ui.result.current.change('gui'));
  ui.rerender({ ...args, enabled: true, runtimeKey: 'running', initialMode: 'tui', prepare });
  await waitFor(() => expect(ui.result.current.generation).toBe('routed-task'));
  expect(ui.result.current.mode).toBe('gui');
  expect(prepare).toHaveBeenCalledOnce();
  expect(invoke.mock.calls.every(([request]) => request.action === 'status')).toBe(true);
});

it('does not apply an old routed TUI selection to a different owner before hydration', async () => {
  invoke.mockResolvedValue({ supported: false });
  const prepare = vi.fn(async () => {});
  const ui = renderHook(useAgentPresentation, { initialProps: {
    ...args, enabled: false, initialMode: 'tui' as const, prepare,
  } });
  ui.rerender({ ...args, ownerId: 'other', enabled: true, initialMode: 'tui', prepare });
  await act(async () => {});
  expect(prepare).not.toHaveBeenCalled();
  expect(ui.result.current.mode).toBe('gui');
});
