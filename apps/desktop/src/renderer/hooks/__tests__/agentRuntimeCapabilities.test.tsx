// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { AgentRuntimeCapabilitiesContext, beginLocalCapabilitiesRefresh, commitLocalCapabilitiesSnapshot,
  getCachedCapabilities, useAgentCapabilities, type AgentCapabilities } from '../useAgentCapabilities';
import type { AgentRuntimeSnapshot } from '../../../shared/agentPresentation';

afterEach(cleanup);

it('overlays only the current task/runtime and leaves catalogue and other tasks unchanged', () => {
  const catalogue = { availableModels: [], hasFastMode: false, effortLevels: [], permissionModes: [],
    sameTurnSteer: { supported: true } } as AgentCapabilities;
  commitLocalCapabilitiesSnapshot(beginLocalCapabilitiesRefresh(), [['codex', catalogue]]);
  const restricted: AgentRuntimeSnapshot = { agentKind: 'codex', capabilities: {
    sameTurnSteer: { supported: false, reason: 'not-implemented', recovery: 'native-ui' },
  } as AgentRuntimeSnapshot['capabilities'] };
  const task = renderHook(({ runtime }) => useAgentCapabilities('codex', undefined, runtime), { initialProps: { runtime: restricted as AgentRuntimeSnapshot | undefined } });
  const other = renderHook(() => useAgentCapabilities('codex'));
  expect(task.result.current.capabilities?.sameTurnSteer?.supported).toBe(false);
  expect(other.result.current.capabilities?.sameTurnSteer?.supported).toBe(true);
  expect(getCachedCapabilities('codex')).toBe(catalogue);
  act(() => task.rerender({ runtime: { ...restricted, agentKind: 'pi' } }));
  expect(task.result.current.capabilities?.sameTurnSteer?.supported).toBe(true);
  task.rerender({ runtime: undefined });
  expect(task.result.current.capabilities?.sameTurnSteer?.supported).toBe(true);
});

it('inherits task capabilities in nested controls only on the same device', () => {
  const catalogue = getCachedCapabilities('codex')!;
  const runtime = { agentKind: 'codex', capabilities: { sameTurnSteer: { supported: false, reason: 'not-implemented' } } } as AgentRuntimeSnapshot;
  const ui = renderHook(() => useAgentCapabilities('codex'), { wrapper: ({ children }) =>
    <AgentRuntimeCapabilitiesContext.Provider value={{ deviceId: 'different-device', runtime }}>{children}</AgentRuntimeCapabilitiesContext.Provider> });
  expect(ui.result.current.capabilities).toBe(catalogue);
});
