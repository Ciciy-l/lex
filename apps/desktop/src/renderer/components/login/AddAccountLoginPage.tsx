import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useAppShellCover } from '@/contexts/AppShellCoverContext';
import { useAuth } from '@/contexts/AuthContext';
import { LoginPage } from './LoginPage';
import { LoginServiceSelection } from './LoginServiceSelection';
import { LexServerLoginPage } from './LexServerLoginPage';
import type { DesktopLoginServiceInput } from '../../../shared/authIpc';

interface AddAccountLocationState {
  returnTo?: string;
}

export function AddAccountLoginPage() {
  const { loginState, beginAddAccount, cancelAddAccount } = useAuth();
  const { reportLocalDbGate } = useAppShellCover();
  const navigate = useNavigate();
  const location = useLocation();
  const initializedRef = useRef(false);
  const flowFinishedRef = useRef(false);
  const closeStartedRef = useRef(false);
  const [flowInitialized, setFlowInitialized] = useState(false);
  const [serviceSelected, setServiceSelected] = useState<DesktopLoginServiceInput | null>(null);
  const returnTo = (location.state as AddAccountLocationState | null)?.returnTo ?? '/cc-agent';

  useEffect(() => {
    // This protected route intentionally sits outside LocalDbGate: adding another account must
    // remain available even if the current account's database cannot open. After a renderer
    // reload/HMR, AppShellCoverProvider starts at `pending`; without an explicit bypass no gate is
    // mounted to release the startup cover, leaving this page behind “Waking Cindy…” forever.
    // Passive effect ordering matters here: LocalDbGate's unmount cleanup runs before this mount
    // effect, so `ready` wins when navigating from the main app into this route.
    reportLocalDbGate('ready');
    return () => reportLocalDbGate('pending');
  }, [reportLocalDbGate]);

  const startLogin = async (service: DesktopLoginServiceInput) => {
    initializedRef.current = true;
    await beginAddAccount(service);
    if (closeStartedRef.current) return;
    setFlowInitialized(true);
    setServiceSelected(service);
  };

  useEffect(() => {
    if (!flowInitialized || loginState?.step !== 'completed') return;
    flowFinishedRef.current = true;
    navigate(returnTo, { replace: true });
  }, [flowInitialized, loginState?.step, navigate, returnTo]);

  useEffect(
    () => () => {
      // Browser history and parent navigation can remove this route without
      // invoking LoginPage's close action. Invalidate the add-account epoch so
      // a late verification or account-selection response cannot switch users.
      if (!initializedRef.current || flowFinishedRef.current || closeStartedRef.current) return;
      void cancelAddAccount();
    },
    [cancelAddAccount],
  );

  const cancel = async () => {
    closeStartedRef.current = true;
    try {
      if (initializedRef.current) await cancelAddAccount();
    } finally {
      navigate(returnTo, { replace: true });
    }
  };

  return serviceSelected ? (
    serviceSelected.kind === 'lex-server'
      ? <LexServerLoginPage onClose={() => void cancel()} />
      : <LoginPage intent="add-account" onClose={() => void cancel()} />
  ) : (
    <LoginServiceSelection onSelect={startLogin} onCancel={() => void cancel()} />
  );
}
