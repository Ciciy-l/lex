import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/contexts/AuthContext';
import { useLogin } from '@/hooks/useLogin';
import { toast } from '@/lib/toast';
import { LoginPage } from './LoginPage';
import { LexServerLoginPage } from './LexServerLoginPage';

export function RootLoginPage() {
  const { isInitializing, loginService } = useAuth();
  const { loginState, enterLocalMode } = useLogin({ autoLoad: !isInitializing });
  const { t } = useTranslation();
  const closingRef = useRef(false);
  // Main resolves the login service together with its state. Never mount Cindy's
  // consent/captcha/SSO presentation before that authoritative response.
  if (isInitializing || !loginState || !loginService) {
    return <p role="status" className="p-6 text-13 text-[var(--text-secondary)]">{t('login.working')}</p>;
  }
  if (loginService.kind === 'cindy') return <LoginPage />;
  const cancel = async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    try { await enterLocalMode(); }
    catch { toast.error(t('login.errors.fallback')); }
    finally { closingRef.current = false; }
  };
  return <LexServerLoginPage intent="sign-in" onClose={() => void cancel()} />;
}
