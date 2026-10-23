// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { createMemoryRouter, Outlet, RouterProvider, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  isInitializing: false, canEnterApp: true, mode: 'local', dataOwnerId: 'local-test',
  loginState: { step: 'identifier' }, service: { kind: 'cindy', realm: 'global' },
  beginAddAccount: vi.fn(), cancelAddAccount: vi.fn(), logout: vi.fn(), exitLocalMode: vi.fn(),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
vi.mock('@/components/title-bar/WindowControls', () => ({ WindowControls: () => null }));
vi.mock('@/components/login/LoginPage', () => ({ LoginPage: ({ onClose }: { onClose?: () => void }) => <button onClick={onClose}>close login</button> }));
vi.mock('@/components/layout/MainLayout', () => ({ MainLayout: () => <Outlet /> }));
vi.mock('@/components/settings/SettingsView', () => ({ SettingsView: () => {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/add-account', { state: { returnTo: '/settings' } })}>login or add account</button>;
} }));
vi.mock('@/components/error/LocalDbFatalScreen', () => ({ LocalDbFatalScreen: () => <p>database fatal</p> }));
vi.mock('@/components/layout/SidebarWindowLayout', () => ({ SidebarWindowLayout: () => null }));
vi.mock('@/components/layout/GhostPanelWindowLayout', () => ({ GhostPanelWindowLayout: () => null }));
vi.mock('@/components/error/RouteErrorFallback', () => ({ RouteErrorFallback: () => null }));
vi.mock('@/features/cc-agent/CCAgentFeatureLayout', () => ({ CCAgentFeatureLayout: () => null }));
vi.mock('@/features/cc-agent/CCAgentIndexRedirect', () => ({ CCAgentIndexRedirect: () => null }));
vi.mock('@/features/cc-agent/SecondaryWindowBootGate', () => ({ SecondaryWindowBootGate: () => null }));
vi.mock('@/features/cc-agent/CCAgentSessionView', () => ({ CCAgentSessionView: () => null }));
vi.mock('@/features/cc-agent/NewMakerDraftRoute', () => ({ NewMakerDraftRoute: () => null }));
vi.mock('@/features/cc-agent/OrcaWorkflowRoute', () => ({ OrcaWorkflowRoute: () => null }));
vi.mock('@/features/cc-agent/workdir-browse/WorkdirBrowseRoute', () => ({ WorkdirBrowseRoute: () => null }));
vi.mock('@/features/issue-tracker/IssueTrackerFeatureLayout', () => ({ IssueTrackerFeatureLayout: () => null }));
vi.mock('@/features/skillhub/SkillhubFeatureLayout', () => ({ SkillhubFeatureLayout: () => null }));
vi.mock('@/features/skillhub/SkillhubHomeView', () => ({ SkillhubHomeView: () => null }));
vi.mock('@/features/skillhub/SkillhubDetailView', () => ({ SkillhubDetailView: () => null }));
vi.mock('@/features/skillhub/SkillhubMarketListView', () => ({ SkillhubMarketListView: () => null }));
vi.mock('@/features/maker-experimental/MakerExperimentalView', () => ({ MakerExperimentalView: () => null }));
vi.mock('@/features/scheduler', () => ({ SchedulerPage: () => null }));
vi.mock('@/features/plugin/GhostPluginPage', () => ({ GhostPluginPage: () => null }));
vi.mock('@/features/plugin/GhostMainViewFeatureLayout', () => ({ GhostMainViewFeatureLayout: () => null }));

import { AppShellCoverProvider, useAppShellCover } from '@/contexts/AppShellCoverContext';
import { router as productionRouter } from '@/router';

function CoverProbe() {
  const { coverHeld } = useAppShellCover();
  return <output data-testid="cover">{coverHeld ? 'waking' : 'ready'}</output>;
}
function tree() {
  const router = createMemoryRouter(productionRouter.routes, { initialEntries: ['/settings'] });
  return { router, element: <AppShellCoverProvider><CoverProbe /><RouterProvider router={router} /></AppShellCoverProvider> };
}
const ensureReady = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  auth.mode = 'local'; auth.dataOwnerId = 'local-test';
  auth.isInitializing = false; auth.canEnterApp = true;
  auth.beginAddAccount.mockResolvedValue({ success: true, state: { step: 'identifier' } });
  auth.cancelAddAccount.mockResolvedValue(undefined);
  ensureReady.mockResolvedValue({ ready: true });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    platform: 'darwin', localDb: { ensureReady, maintenance: { getLastResult: async () => null } },
    appReadyForBot: vi.fn(async () => undefined),
  } });
});
afterEach(cleanup);

async function openSelection() {
  fireEvent.click(await screen.findByRole('button', { name: 'login or add account' }));
  await screen.findByRole('heading', { name: 'login.serviceSelection.title' });
}
async function cancelSelection() {
  fireEvent.click(screen.getByRole('button', { name: 'logic.confirm.cancel' }));
  await screen.findByRole('button', { name: 'login or add account' });
}

describe('production login routes retain the current owner readiness', () => {
  it('cold boot waits for its database, then repeated guest login/back never reinitializes it', async () => {
    let finish!: (value: { ready: true }) => void;
    ensureReady.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const { element, router } = tree();
    render(element);
    expect(screen.getByTestId('cover').textContent).toBe('waking');
    expect(screen.queryByRole('button', { name: 'login or add account' })).toBeNull();
    await act(async () => finish({ ready: true }));
    await screen.findByRole('button', { name: 'login or add account' });
    for (let i = 0; i < 2; i++) {
      await openSelection();
      fireEvent.click(screen.getByRole('button', { name: 'Lex Server' }));
      fireEvent.click(screen.getByRole('button', { name: 'login.back' }));
      await cancelSelection();
      expect(screen.getByTestId('cover').textContent).toBe('ready');
    }
    expect(router.state.location.pathname).toBe('/settings');
    expect(ensureReady).toHaveBeenCalledExactlyOnceWith('local-test');
    expect(window.electronAPI.appReadyForBot).toHaveBeenCalledOnce();
    expect(auth.beginAddAccount).not.toHaveBeenCalled();
    expect(auth.logout).not.toHaveBeenCalled();
    expect(auth.exitLocalMode).not.toHaveBeenCalled();
  });

  it('cloud add-account close preserves owner/service and skips repeated database readiness', async () => {
    auth.mode = 'cloud'; auth.dataOwnerId = 'cloud-A';
    const service = auth.service;
    const { element } = tree(); render(element);
    await openSelection();
    fireEvent.click(screen.getByRole('button', { name: 'Cindy' }));
    fireEvent.click(await screen.findByRole('button', { name: 'close login' }));
    await screen.findByRole('button', { name: 'login or add account' });
    expect(auth.cancelAddAccount).toHaveBeenCalledOnce();
    expect(auth.dataOwnerId).toBe('cloud-A'); expect(auth.service).toBe(service);
    expect(ensureReady).toHaveBeenCalledExactlyOnceWith('cloud-A');
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it('cancel during pending preflight invalidates the flow and late completion cannot leave the original page', async () => {
    let finish!: (value: unknown) => void;
    auth.beginAddAccount.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const { element, router } = tree(); render(element);
    await openSelection();
    fireEvent.click(screen.getByRole('button', { name: 'Cindy' }));
    await cancelSelection();
    expect(auth.cancelAddAccount).toHaveBeenCalledOnce();
    await act(async () => finish({ success: true, state: { step: 'completed' } }));
    expect(router.state.location.pathname).toBe('/settings');
    expect(auth.dataOwnerId).toBe('local-test');
    expect(ensureReady).toHaveBeenCalledOnce();
  });

  it('database fatal does not block adding an account and remains fatal on return', async () => {
    ensureReady.mockResolvedValue({ ready: false, error: { code: 'DB_INIT_FAILED' } });
    const { element, router } = tree(); render(element);
    await screen.findByText('database fatal');
    await act(async () => router.navigate('/add-account', { state: { returnTo: '/settings' } }));
    await screen.findByRole('heading', { name: 'login.serviceSelection.title' });
    fireEvent.click(screen.getByRole('button', { name: 'logic.confirm.cancel' }));
    await screen.findByText('database fatal');
    expect(ensureReady).toHaveBeenCalledOnce();
  });

  it('a real cold remount or a different owner still checks readiness', async () => {
    const first = render(tree().element);
    await screen.findByRole('button', { name: 'login or add account' }); first.unmount();
    auth.mode = 'cloud'; auth.dataOwnerId = 'cloud-B';
    let finish!: (value: { ready: true }) => void;
    ensureReady.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    render(tree().element);
    expect(screen.getByTestId('cover').textContent).toBe('waking');
    expect(screen.queryByRole('button', { name: 'login or add account' })).toBeNull();
    await act(async () => finish({ ready: true }));
    await screen.findByRole('button', { name: 'login or add account' });
    expect(ensureReady.mock.calls.map(call => call[0])).toEqual(['local-test', 'cloud-B']);
  });
});
