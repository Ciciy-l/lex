// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogModel, ProviderView } from '@cindy/model-providers';
import { StartRemoteSessionPanel } from '@/components/settings/RemoteHostDetail';
import {
  beginProvidersRefresh,
  commitProvidersSnapshot,
  invalidateProvidersSnapshot,
} from '@/lib/providersSnapshotStore';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  navigate: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  confirm: vi.fn(),
  stat: vi.fn(),
  mkdir: vi.fn(),
  prefs: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.error, success: mocks.success } }));
vi.mock('@/lib/sessionService', () => ({ create: mocks.create }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));
vi.mock('@/state/newMakerDraft', () => ({
  getDraft: () => ({ lastByVendor: { codex: mocks.prefs() } }),
  getFastModeForModel: () => false,
}));
vi.mock('@/state/providerModelMemory', () => ({
  getProviderModelEffort: () => undefined,
  getProviderModelFast: () => undefined,
}));

function model(id: string): CatalogModel {
  return {
    id,
    name: id,
    contextWindow: 200_000,
    efforts: ['low', 'high'],
    defaultEffort: 'high',
  };
}

function nativeProvider(models: CatalogModel[]): ProviderView {
  return {
    id: 'openai',
    name: 'OpenAI',
    source: 'builtin',
    connected: true,
    agents: ['codex'],
    auth: { method: 'oauth' },
    routing: {
      codex: {
        upstream: 'https://chatgpt.com/backend-api/codex',
        authStrategy: 'oauth-passthrough',
      },
    },
    models: { codex: models },
  };
}

function publish(models: CatalogModel[]) {
  commitProvidersSnapshot(beginProvidersRefresh(), {
    dataOwnerId: 'owner',
    ownerGeneration: 1,
    providerOrder: ['openai'],
    providers: [nativeProvider(models)],
  });
}

function start() {
  render(<StartRemoteSessionPanel hostId="remote-host" />);
  fireEvent.click(screen.getByRole('button', { name: 'settings.remote.startSession.start' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  setDataOwnerGeneration('owner', 1);
  invalidateProvidersSnapshot();
  publish([model('selected-model'), model('other-valid-model')]);
  mocks.prefs.mockReturnValue({ model: 'selected-model', providerId: null, effort: 'low' });
  mocks.create.mockResolvedValue({ id: 'created-session' });
  mocks.stat.mockResolvedValue({ kind: 'dir', resolvedPath: '/remote/project' });
  mocks.mkdir.mockResolvedValue({ resolvedPath: '/remote/project' });
  mocks.confirm.mockResolvedValue(true);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      remoteSsh: {
        statRemotePath: mocks.stat,
        mkdirPRemote: mocks.mkdir,
      },
    },
  });
});

afterEach(() => {
  cleanup();
  setDataOwnerGeneration(null);
});

describe('settings SSH Codex creation race', () => {
  it('stops creation when the valid draft model changes during remote path validation', async () => {
    let releaseStat!: (result: { kind: 'dir'; resolvedPath: string }) => void;
    const delayedStat = new Promise<{ kind: 'dir'; resolvedPath: string }>((resolve) => {
      releaseStat = resolve;
    });
    mocks.stat.mockReturnValueOnce(delayedStat);

    start();
    await waitFor(() => expect(mocks.stat).toHaveBeenCalledTimes(1));

    mocks.prefs.mockReturnValue({
      model: 'other-valid-model',
      providerId: 'openai',
      effort: 'high',
    });
    releaseStat({ kind: 'dir', resolvedPath: '/remote/project' });

    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith('settings.remote.startSession.selectionChanged'),
    );
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('creates a stable selected OpenAI subscription route successfully', async () => {
    start();

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/created-session'));
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith({
      agentKind: 'codex',
      workingDir: '/remote/project',
      workspaceKind: 'project',
      permissionMode: 'auto',
      model: 'selected-model',
      providerId: 'openai',
      effort: 'low',
      fastMode: false,
      remoteHostId: 'remote-host',
    });
  });

  it('does not create a session when the confirmed missing directory becomes a file', async () => {
    mocks.stat
      .mockResolvedValueOnce({ kind: 'missing', resolvedPath: '/remote/project' })
      .mockResolvedValueOnce({ kind: 'file', resolvedPath: '/remote/project' });

    start();

    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith('settings.remote.startSession.errorWorkdirIsFile'),
    );
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
