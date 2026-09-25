// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogModel, ProviderView } from '@cindy/model-providers';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { loadSshSessionModelSelection } from '@/features/cc-agent/sshSessionModelSelection';
import { useSshCodexProviders } from '@/hooks/useSshCodexProviders';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  statusChanged: null as null | ((snapshot: { config: { id: string }; status: string }) => void),
}));

function model(id: string): CatalogModel {
  return { id, name: id, contextWindow: 272_000, efforts: ['low', 'high'], defaultEffort: 'high' };
}

function provider(modelId: string): ProviderView {
  return {
    id: 'openai',
    name: 'OpenAI Codex',
    source: 'builtin',
    connected: true,
    agents: ['codex'],
    auth: { method: 'oauth', native: 'codex' },
    routing: {
      codex: {
        upstream: 'https://chatgpt.com/backend-api/codex',
        authStrategy: 'oauth-passthrough',
      },
    },
    models: { codex: [model(modelId)] },
  };
}

function publishStatus(hostId: string, status: string) {
  act(() => mocks.statusChanged?.({ config: { id: hostId }, status }));
}

beforeEach(() => {
  vi.clearAllMocks();
  setDataOwnerGeneration('owner-a', 1);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      remoteSsh: {
        listCodexModels: mocks.list,
        onStatusChanged: (callback: typeof mocks.statusChanged) => {
          mocks.statusChanged = callback;
          return vi.fn();
        },
      },
    },
  });
});

afterEach(() => {
  cleanup();
  setDataOwnerGeneration(null);
});

describe('SSH Codex host model discovery', () => {
  it('uses the host default despite controller catalog failure and rejects explicit non-native sources', async () => {
    mocks.list.mockResolvedValueOnce([provider('host-default')]);
    await expect(loadSshSessionModelSelection('builder', {
      agentKind: 'codex',
      preferred: { providerId: 'openai' },
    })).resolves.toMatchObject({
      ok: true,
      model: 'host-default',
      providerId: 'openai',
      effort: 'high',
      fastMode: false,
    });
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith('builder');

    mocks.list.mockClear();
    await expect(loadSshSessionModelSelection('builder', {
      agentKind: 'codex',
      preferred: { model: 'controller-model', providerId: 'custom-provider' },
    })).resolves.toEqual({ ok: false, reason: 'unsupported-codex-source' });
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('does not replace an explicit model absent from this host or fall back after a read failure', async () => {
    mocks.list.mockResolvedValueOnce([provider('host-model')]);
    await expect(loadSshSessionModelSelection('builder', {
      agentKind: 'codex',
      preferred: { model: 'missing-model', providerId: 'openai' },
    })).resolves.toEqual({ ok: false, reason: 'no-route' });

    mocks.list.mockRejectedValueOnce(new Error('remote is unavailable'));
    await expect(loadSshSessionModelSelection('builder', {
      agentKind: 'codex',
      preferred: { model: 'controller-model', providerId: 'openai' },
    })).resolves.toEqual({ ok: false, reason: 'catalog-error' });
  });

  it('drops late results from a previous host', async () => {
    let finishFirst!: (value: ProviderView[]) => void;
    mocks.list
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce([provider('host-b-model')]);
    const view = renderHook(({ hostId }) => useSshCodexProviders(hostId), {
      initialProps: { hostId: 'host-a' },
    });

    view.rerender({ hostId: 'host-b' });
    await waitFor(() => expect(view.result.current.providers[0]?.models.codex?.[0]?.id).toBe('host-b-model'));
    await act(async () => finishFirst([provider('host-a-model')]));

    expect(view.result.current.providers[0]?.models.codex?.[0]?.id).toBe('host-b-model');
  });

  it('drops late results from a previous owner generation', async () => {
    let finishFirst!: (value: ProviderView[]) => void;
    mocks.list
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce([provider('owner-b-model')]);
    const view = renderHook(() => useSshCodexProviders('builder'));

    setDataOwnerGeneration('owner-b', 2);
    view.rerender();
    await waitFor(() => expect(view.result.current.providers[0]?.models.codex?.[0]?.id).toBe('owner-b-model'));
    await act(async () => finishFirst([provider('owner-a-model')]));

    expect(view.result.current.providers[0]?.models.codex?.[0]?.id).toBe('owner-b-model');
  });

  it('recovers a failed initial read when the host becomes ready and refreshes once per reconnect', async () => {
    mocks.list.mockRejectedValueOnce(new Error('not ready')).mockResolvedValue([provider('host-model')]);
    const view = renderHook(() => useSshCodexProviders('builder'));
    await waitFor(() => expect(view.result.current.status).toBe('error'));

    publishStatus('builder', 'ready');
    await waitFor(() => expect(view.result.current.status).toBe('ready'));
    expect(mocks.list).toHaveBeenCalledTimes(2);

    publishStatus('builder', 'ready');
    publishStatus('builder', 'ready');
    expect(mocks.list).toHaveBeenCalledTimes(2);

    publishStatus('builder', 'disconnected');
    expect(view.result.current.status).toBe('error');
    publishStatus('builder', 'connecting');
    publishStatus('builder', 'ready');
    await waitFor(() => expect(view.result.current.status).toBe('ready'));
    expect(mocks.list).toHaveBeenCalledTimes(3);
  });
});
