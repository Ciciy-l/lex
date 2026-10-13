// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessKind, HarnessRuntimeState } from '../../../../shared/harnessSettings';
import { HarnessVersionsSection } from '../HarnessVersionsSection';
import { harnessErrorKey } from '../harnessErrorKey';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
const api = { check: vi.fn(), install: vi.fn(), onProgress: vi.fn() };
function state(kind: HarnessKind): HarnessRuntimeState {
  return {
    kind,
    currentVersion: '0.84.4',
    selectedVersion: null,
    restartRequired: false,
    baseline: { version: '0.84.4', source: 'baseline' },
    upstream: null,
    checkedAt: 1,
    phase: 'idle',
    percent: null,
    error: null,
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  api.check.mockImplementation(async (kind) => state(kind));
  api.onProgress.mockReturnValue(() => undefined);
  Object.assign(window, { electronAPI: { maker: { harness: api } } });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'electronAPI');
});

describe('Harness version feedback', () => {
  it('shows the Pi asset error without a misleading network instruction and retries only Pi', async () => {
    api.check.mockImplementation(async (kind) =>
      kind === 'pi'
        ? {
            ...state(kind),
            phase: 'failed',
            error: 'RELEASE_HAS_NO_VERIFIED_ASSET',
            failureStage: 'check',
          }
        : state(kind),
    );
    const view = render(<HarnessVersionsSection />);
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'settings.harness.errors.asset',
    );
    expect(screen.queryByText('settings.harness.runtimeFailed')).toBeNull();
    expect(view.container.querySelectorAll('[aria-live]')).toHaveLength(1);
    api.check.mockImplementation(async (kind) => state(kind));
    fireEvent.click(screen.getAllByRole('button', { name: 'settings.harness.check' })[2]!);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(api.check).toHaveBeenLastCalledWith('pi', true);
    expect(api.install).not.toHaveBeenCalled();
    expect(view.container.querySelectorAll('[aria-live]')).toHaveLength(0);
  });

  it('keeps a rejected Pi request retryable without disabling other engine controls', async () => {
    api.check.mockImplementation(async (kind) => {
      if (kind === 'pi') throw new Error('transport unavailable');
      return state(kind);
    });
    render(<HarnessVersionsSection />);
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'settings.harness.errors.check',
    );
    const checks = screen.getAllByRole('button', { name: 'settings.harness.check' });
    expect(checks.every((button) => !(button as HTMLButtonElement).disabled)).toBe(true);
    api.check.mockImplementation(async (kind) => state(kind));
    fireEvent.click(checks[2]!);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('clears only the recovered engine request error when fresh progress arrives', async () => {
    api.check.mockImplementation(async (kind) => {
      if (kind === 'pi') throw new Error('transport unavailable');
      return state(kind);
    });
    render(<HarnessVersionsSection />);
    await screen.findByRole('alert');
    const progress = api.onProgress.mock.calls[0]![0] as (state: HarnessRuntimeState) => void;
    act(() => progress(state('omp')));
    expect(screen.getByRole('alert')).toBeTruthy();
    act(() => progress({ ...state('pi'), phase: 'checking' }));
    expect(screen.queryByRole('alert')).toBeNull();
    const checks = screen.getAllByRole('button', { name: 'settings.harness.check' });
    expect((checks[2] as HTMLButtonElement).disabled).toBe(true);
    act(() => progress(state('pi')));
    expect((checks[2] as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([
    ['TIMEOUT', 'check', 'checkNetwork'],
    ['TIMEOUT', 'download', 'downloadNetwork'],
    ['RELEASE_LOOKUP_HTTP_429', 'check', 'rateLimit'],
    ['CHECKSUM', 'download', 'verify'],
    ['RUNTIME_VERSION_MISMATCH', 'verify', 'verify'],
    ['RUNTIME_INSTALL_FAILED', 'extract', 'extract'],
    ['EPERM', 'publish', 'permission'],
    ['ENOSPC', 'download', 'disk'],
    ['REFRESH_RELEASE_LIST', undefined, 'refresh'],
  ] as const)('maps %s at %s to actionable copy', (code, stage, key) => {
    expect(harnessErrorKey(code, stage)).toBe('settings.harness.errors.' + key);
  });
});
