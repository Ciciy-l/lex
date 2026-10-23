// @vitest-environment jsdom
import { useEffect, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthService, AuthFlowState } from '@cindy/auth-client';

const auth = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
  load: vi.fn(), dispatch: vi.fn(), enterLocal: vi.fn(), list: vi.fn(), begin: vi.fn(),
  apply: null as null | ((service: AuthService, state: AuthFlowState | null) => void),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth.current }));
vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
vi.mock('@/components/title-bar/WindowControls', () => ({ WindowControls: () => null }));

import { RootLoginPage } from '../RootLoginPage';
import { LOGIN_HANDOFF_TIMINGS as timing, LoginHandoffProvider, useLoginHandoff } from '@/contexts/LoginHandoffContext';

const lex: AuthService = { kind: 'lex-server', origin: 'https://lex.test:8443' };
const identifier: AuthFlowState = {
  step: 'identifier', providers: { region: 'global', email: true, phone: false, social: [], attribution: 'email' },
};
function Harness({ service = lex, state = identifier, initializing = false }: {
  service?: AuthService; state?: AuthFlowState | null; initializing?: boolean;
}) {
  const [projection, setProjection] = useState({ service, state });
  auth.apply = (nextService, nextState) => setProjection({ service: nextService, state: nextState });
  auth.current = {
    loginService: projection.service, loginState: projection.state, isInitializing: initializing,
    loginRealm: projection.service.kind === 'cindy' ? projection.service.realm : 'global',
    loadLoginState: auth.load, dispatchLoginAction: auth.dispatch, enterLocalMode: auth.enterLocal,
    listAccounts: auth.list, beginAddAccount: auth.begin,
  };
  return <RootLoginPage />;
}
beforeEach(() => {
  vi.clearAllMocks();
  auth.enterLocal.mockResolvedValue(undefined);
  auth.list.mockResolvedValue({ accounts: [], currentAccountKey: null });
  auth.load.mockImplementation(async () => {
    auth.apply!(lex, identifier);
    return { success: true, service: lex, realm: 'global', state: identifier };
  });
  auth.dispatch.mockImplementation(async action => {
    const state = action.type === 'reset' ? identifier : auth.current.loginState;
    auth.apply!(lex, state as AuthFlowState);
    return { success: true, service: lex, realm: 'global', state };
  });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    platform: 'darwin', acceptPrivacyConsent: vi.fn(async () => ({ allowed: true })),
  } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

function StartupAnchors() {
  const { phase, reportBrandAssetsReady, reportSplashExited, reportSplashExitCompleted } = useLoginHandoff();
  useEffect(() => {
    reportBrandAssetsReady(); reportSplashExited(); reportSplashExitCompleted();
  }, [reportBrandAssetsReady, reportSplashExited, reportSplashExitCompleted]);
  return <output data-testid="handoff">{phase}</output>;
}

describe('root login service presentation', () => {
  it('expired Lex identifier uses the real email component without Cindy consent, SSO or region', () => {
    render(<Harness />);
    expect(screen.getByRole('heading', { name: 'Lex Server' })).toBeTruthy();
    expect(screen.getByLabelText('login.lexServer.email').getAttribute('type')).toBe('email');
    expect(screen.getByText(lex.origin)).toBeTruthy();
    expect(screen.queryByTestId('login-social-sso')).toBeNull();
    expect(screen.queryByText('login.consentStatement')).toBeNull();
    expect(screen.queryByText('login.personalRegion.label')).toBeNull();
    expect(auth.load).not.toHaveBeenCalled();
    expect(auth.begin).not.toHaveBeenCalled();
    expect(auth.dispatch).not.toHaveBeenCalled();
  });

  it('waits for the Main login projection before mounting any Cindy entry or initializing twice', async () => {
    let finish!: () => void;
    auth.load.mockImplementation(() => new Promise(resolve => {
      finish = () => {
        auth.apply!(lex, identifier);
        resolve({ success: true, service: lex, realm: 'global', state: identifier });
      };
    }));
    render(<Harness service={{ kind: 'cindy', realm: 'global' }} state={null} />);
    expect(screen.queryByTestId('login-social-sso')).toBeNull();
    expect(screen.queryByText('login.consentStatement')).toBeNull();
    expect(auth.load).toHaveBeenCalledOnce();
    await act(async () => finish());
    expect(screen.getByLabelText('login.lexServer.email')).toBeTruthy();
    expect(auth.load).toHaveBeenCalledOnce();
    expect(auth.dispatch).not.toHaveBeenCalled();
  });

  it('does not load before auth initialization finishes', () => {
    render(<Harness state={null} initializing />);
    expect(auth.load).not.toHaveBeenCalled();
    expect(screen.queryByTestId('login-social-sso')).toBeNull();
  });

  it('Lex cold entry completes the existing brand handoff and retains the saved-account entry', async () => {
    vi.useFakeTimers();
    auth.list.mockResolvedValue({ accounts: [{ accountKey: 'opaque-test-key' }], mutationAllowed: true });
    render(<LoginHandoffProvider authResolved authenticated={false}><StartupAnchors /><Harness /></LoginHandoffProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(timing.settleMs + timing.shiftMs); });
    expect(screen.getByTestId('handoff').textContent).toBe('panel');
    await act(async () => { await vi.advanceTimersByTimeAsync(timing.panelMs + timing.doneBufferMs); });
    expect(screen.getByTestId('handoff').textContent).toBe('done');
    expect(screen.getByTestId('login-account-switcher')).toBeTruthy();
    expect(auth.dispatch).not.toHaveBeenCalled();
  });

  it('Lex retry uses the existing reset; cancel enters the Main-owned guest without beginning or sending a code', async () => {
    render(<Harness state={{ step: 'error', code: 'NETWORK_ERROR', recoverTo: 'identifier' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'login.lexServer.retry' }));
    await screen.findByLabelText('login.lexServer.email');
    expect(auth.dispatch).toHaveBeenCalledExactlyOnceWith({ type: 'reset' });
    fireEvent.click(screen.getByRole('button', { name: 'logic.confirm.cancel' }));
    await waitFor(() => expect(auth.enterLocal).toHaveBeenCalledOnce());
    expect(auth.begin).not.toHaveBeenCalled();
    expect(auth.load).not.toHaveBeenCalled();
  });

  it.each(['cn', 'global'] as const)('Cindy %s retains the real SSO, region and consent gate', async realm => {
    render(<Harness service={{ kind: 'cindy', realm }} state={{ ...identifier, providers: { ...identifier.providers, region: realm } }} />);
    expect(screen.getByTestId('login-social-sso')).toBeTruthy();
    expect(screen.getByText('login.consentStatement')).toBeTruthy();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'test@example.test' } });
    fireEvent.submit(input.closest('form')!);
    expect(auth.dispatch).not.toHaveBeenCalled();
    expect(screen.getByTestId('login-consent-dialog')).toBeTruthy();
    expect(window.electronAPI.acceptPrivacyConsent).not.toHaveBeenCalled();
  });
});
