import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { isValidEmail } from '@cindy/auth-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/contexts/AuthContext';
import { useLogin } from '@/hooks/useLogin';
import { WindowControls } from '@/components/title-bar/WindowControls';
import { WINDOW_DRAG_STYLE, WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { useResendCountdown } from './useResendCountdown';

/** Presentation only: uses the same Main-owned login, tickets and commit transaction as Cindy. */
export function LexServerLoginPage({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { loginService } = useAuth();
  const { loginState, dispatch, isLoading, errorCode, clearError } = useLogin({ autoLoad: false });
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const verification = loginState?.step === 'verification-code' ? loginState : null;
  const { remaining, arm } = useResendCountdown(!!verification, 60_000);
  const verificationIdentifier = verification?.identifier;
  useEffect(() => { if (verificationIdentifier) arm(); }, [verificationIdentifier, arm]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (isLoading) return;
    if (verification) {
      if (/^\d{6}$/u.test(code)) void dispatch({ type: 'verify-code', kind: 'email', identifier: verification.identifier, code });
    } else if (isValidEmail(email.trim())) void dispatch({ type: 'discover', email: email.trim() });
  };
  const reset = () => { setCode(''); clearError(); void dispatch({ type: 'reset' }); };
  const error = errorCode ?? (loginState?.step === 'error' ? loginState.code : null);
  const origin = loginService?.kind === 'lex-server' ? loginService.origin : '';
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--surface)] px-6 py-16 text-[var(--text-primary)]">
      <div className="absolute inset-x-0 top-0 flex h-[46px] justify-end" style={WINDOW_DRAG_STYLE}>
        {window.electronAPI?.platform !== 'darwin' && <div style={WINDOW_NO_DRAG_STYLE}><WindowControls /></div>}
      </div>
      <section className="w-full max-w-[400px] rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-6" aria-labelledby="lex-login-title">
        <h1 id="lex-login-title" className="text-20 font-medium">Lex Server</h1>
        <p className="mt-2 break-all text-13 text-[var(--text-secondary)]">{origin}</p>
        <p className="mt-3 text-13 leading-relaxed text-[var(--text-secondary)]">{t('login.lexServer.emailDescription')}</p>
        {loginState?.step === 'account-selection' ? (
          <div className="mt-6 flex max-h-[360px] flex-col gap-2 overflow-y-auto">
            <h2 className="text-14 font-medium">{t('login.lexServer.chooseIdentity')}</h2>
            {loginState.accounts.map(account => (
              <Button key={account.id} variant="secondary" className="h-auto justify-start whitespace-normal py-3 text-left" disabled={isLoading}
                onClick={() => void dispatch({ type: 'select-account', accountId: account.id })}>
                <span className="flex min-w-0 flex-col"><span>{account.orgName || account.displayName}</span>
                  <span className="text-12 font-normal text-[var(--text-secondary)]">{account.displayName}{account.email ? ` · ${account.email}` : ''}</span>
                </span>
              </Button>
            ))}
          </div>
        ) : loginState?.step === 'identifier' || loginState?.step === 'method-choice' || verification ? (
          <form onSubmit={submit} noValidate className="mt-6 flex flex-col gap-3">
            <label htmlFor="lex-login-input" className="text-13">{t(verification ? 'login.enterCode' : 'login.lexServer.email')}</label>
            {verification && <p className="break-all text-12 text-[var(--text-secondary)]">{verification.identifier}</p>}
            <Input id="lex-login-input" key={verification ? 'code' : 'email'} autoFocus disabled={isLoading}
              type={verification ? 'text' : 'email'} inputMode={verification ? 'numeric' : 'email'}
              autoComplete={verification ? 'one-time-code' : 'email'} maxLength={verification ? 6 : 254}
              value={verification ? code : email} onChange={value => { clearError(); verification ? setCode(value.replace(/\D/gu, '')) : setEmail(value); }} />
            <Button type="submit" variant="primary" disabled={isLoading || (verification ? code.length !== 6 : !isValidEmail(email.trim()))}>
              {t(isLoading ? 'login.working' : 'login.continue')}
            </Button>
            {verification && <Button variant="secondary" disabled={isLoading || remaining > 0} onClick={async () => {
              if (await dispatch({ type: 'request-code', kind: 'email', identifier: verification.identifier })) arm();
            }}>{remaining > 0 ? t('login.lexServer.resendIn', { seconds: remaining }) : t('login.lexServer.resend')}</Button>}
          </form>
        ) : loginState?.step === 'error' ? (
          <Button variant="primary" className="mt-6" disabled={isLoading} onClick={reset}>{t('login.lexServer.retry')}</Button>
        ) : <p role="status" className="mt-6 text-13">{t('login.working')}</p>}
        {error && <p role="alert" className="mt-3 text-13 text-[var(--error-fg)]">{t(`login.errors.${error}`, { defaultValue: t('login.errors.fallback') })}</p>}
        <div className="mt-6 flex justify-end gap-2">
          {verification && <Button variant="secondary" disabled={isLoading} onClick={reset}>{t('login.back')}</Button>}
          <Button variant="secondary" onClick={onClose}>{t('logic.confirm.cancel')}</Button>
        </div>
      </section>
    </div>
  );
}
