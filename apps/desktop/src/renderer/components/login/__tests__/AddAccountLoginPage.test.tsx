// @vitest-environment jsdom

import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const auth = vi.hoisted(() => ({
  isInitializing: false,
  canEnterApp: true,
  dataOwnerId: 'test-owner',
  loginState: { step: 'identifier' },
  beginAddAccount: vi.fn(async () => ({
    success: true,
    state: { step: 'identifier' },
  })),
  cancelAddAccount: vi.fn(async () => undefined),
}));

vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => auth,
}));

vi.mock('@/lib/secondaryWindow', () => ({
  isSecondaryWindow: () => false,
}));
vi.mock('@/lib/sidebarWindow', () => ({
  isSidebarWindow: () => false,
}));
vi.mock('@/lib/ghostPanelWindow', () => ({
  isGhostPanelWindow: () => false,
}));

vi.mock('@/components/title-bar/WindowControls', () => ({ WindowControls: () => null }));

vi.mock('../LoginPage', () => ({
  LoginPage: ({ onClose }: { onClose?: () => void }) => (
    <button type="button" onClick={onClose}>
      close add-account login
    </button>
  ),
}));

import { AppShellCoverProvider, useAppShellCover } from '@/contexts/AppShellCoverContext';
import { AddAccountLoginPage } from '../AddAccountLoginPage';
import { LocalDbGate } from '@/components/auth/LocalDbGate';

function CoverProbe() {
  const { coverHeld, localDbGateStatus } = useAppShellCover();
  return (
    <output data-testid="cover-state">
      {coverHeld ? 'held' : 'open'}:{localDbGateStatus}
    </output>
  );
}

function LocationProbe() {
  return <output data-testid="location-probe">{useLocation().pathname}</output>;
}

function Harness() {
  const [showAddAccount, setShowAddAccount] = useState(true);
  return (
    <AppShellCoverProvider>
      <MemoryRouter
        initialEntries={[{ pathname: '/add-account', state: { returnTo: '/settings' } }]}
      >
        <Routes>
          <Route element={<LocalDbGate />}>
            <Route path="/add-account" element={showAddAccount ? <AddAccountLoginPage /> : null} />
            <Route path="/settings" element={null} />
          </Route>
        </Routes>
        <CoverProbe />
        <LocationProbe />
        <button type="button" onClick={() => setShowAddAccount(false)}>
          leave route
        </button>
      </MemoryRouter>
    </AppShellCoverProvider>
  );
}

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    platform: 'darwin',
    localDb: { ensureReady: async () => ({ ready: true }), maintenance: { getLastResult: async () => null } },
    appReadyForBot: async () => undefined,
  } });
});

afterEach(() => {
  cleanup();
  auth.beginAddAccount.mockReset();
  auth.beginAddAccount.mockResolvedValue({
    success: true,
    state: { step: 'identifier' },
  });
  auth.cancelAddAccount.mockReset();
  auth.cancelAddAccount.mockResolvedValue(undefined);
  auth.loginState = { step: 'identifier' };
});

describe('AddAccountLoginPage app-shell cover', () => {
  it('releases a freshly reset cover and cancels the flow when leaving', async () => {
    render(<Harness />);

    expect(screen.getByTestId('cover-state').textContent).toBe('open:ready');
    expect(auth.beginAddAccount).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cindy' }));
    await waitFor(() => expect(auth.beginAddAccount).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: 'leave route' }));
    expect(screen.getByTestId('cover-state').textContent).toBe('open:ready');
    await waitFor(() => expect(auth.cancelAddAccount).toHaveBeenCalledOnce());
  });

  it('returns to the current page without starting auth when service selection is cancelled', async () => {
    render(<Harness />);
    expect(screen.getAllByRole('button', { name: 'Cindy' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'logic.confirm.cancel' }));
    await waitFor(() => expect(screen.getByTestId('location-probe').textContent).toBe('/settings'));
    expect(auth.beginAddAccount).not.toHaveBeenCalled();
    expect(auth.cancelAddAccount).not.toHaveBeenCalled();
  });

  it('cancels the add-account flow from the close action', async () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Cindy' }));
    fireEvent.click(await screen.findByRole('button', { name: 'close add-account login' }));
    await waitFor(() => expect(auth.cancelAddAccount).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByTestId('location-probe').textContent).toBe('/settings'));
  });

  it('starts a fresh flow before honoring a stale completed state', async () => {
    auth.loginState = { step: 'completed' };
    auth.beginAddAccount.mockImplementation(async () => {
      auth.loginState = { step: 'identifier' };
      return { success: true, state: auth.loginState };
    });

    render(<Harness />);

    expect(auth.beginAddAccount).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cindy' }));
    await waitFor(() => expect(auth.beginAddAccount).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByTestId('location-probe').textContent).toBe('/add-account'),
    );
  });
});
