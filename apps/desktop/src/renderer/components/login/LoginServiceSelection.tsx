import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { WindowControls } from '@/components/title-bar/WindowControls';
import { WINDOW_DRAG_STYLE, WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { Input } from '@/components/ui/input';
import { extractIpcError } from '@/utils/ipcError';
import type { DesktopLoginServiceInput } from '../../../shared/authIpc';

/** Account-service choice only; credentials and the login flow remain in Main. */
export function LoginServiceSelection({
  onSelect,
  onCancel,
}: {
  onSelect: (service: DesktopLoginServiceInput) => void | Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [serverMode, setServerMode] = useState(false);
  const [origin, setOrigin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const select = async (service: DesktopLoginServiceInput) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { await onSelect(service); }
    catch (failure) { setError(extractIpcError(failure)?.code ?? 'SERVER_UNAVAILABLE'); }
    finally { setBusy(false); }
  };
  const submitServer = (event: FormEvent) => {
    event.preventDefault();
    if (origin.trim()) void select({ kind: 'lex-server', origin });
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--surface)] px-6 py-16 text-[var(--text-primary)]">
      <div className="absolute inset-x-0 top-0 flex h-[46px] justify-end" style={WINDOW_DRAG_STYLE}>
        {window.electronAPI?.platform !== 'darwin' && (
          <div style={WINDOW_NO_DRAG_STYLE}><WindowControls /></div>
        )}
      </div>
      <section aria-labelledby="login-service-title" className="w-full max-w-[400px] rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-6">
        <h1 id="login-service-title" className="text-20 font-medium">{serverMode ? 'Lex Server' : t('login.serviceSelection.title')}</h1>
        <p className="mt-2 text-13 leading-relaxed text-[var(--text-secondary)]">{t(serverMode ? 'login.lexServer.addressDescription' : 'login.serviceSelection.description')}</p>
        {serverMode ? (
          <form onSubmit={submitServer} className="mt-6 flex flex-col gap-3">
            <label className="text-13" htmlFor="lex-server-origin">{t('login.lexServer.address')}</label>
            <Input id="lex-server-origin" autoFocus type="url" autoComplete="url" placeholder="https://lex.example.com"
              value={origin} disabled={busy} onChange={value => { setOrigin(value); setError(null); }} />
            <p className="text-12 leading-relaxed text-[var(--text-secondary)]">{t('login.lexServer.addressHint')}</p>
            <Button type="submit" variant="primary" disabled={busy || !origin.trim()}>{t(busy ? 'login.lexServer.checking' : 'login.continue')}</Button>
          </form>
        ) : (
          <div className="mt-6 flex flex-col gap-3">
            <Button autoFocus variant="secondary" size="lg" className="w-full justify-between px-4" disabled={busy} onClick={() => setServerMode(true)}>
              <span>Lex Server</span><ArrowRight size={16} aria-hidden="true" />
            </Button>
            <Button variant="secondary" size="lg" className="w-full justify-between px-4" disabled={busy} onClick={() => void select({ kind: 'cindy' })}>
              <span>Cindy</span><ArrowRight size={16} aria-hidden="true" />
            </Button>
          </div>
        )}
        {error && <p role="alert" className="mt-3 text-13 text-[var(--error-fg)]">{t(
          'login.errors.' + error, { defaultValue: t('login.lexServer.connectionFailed') },
        )}</p>}
        <div className="mt-6 flex justify-end">
          {serverMode && !busy && <Button variant="secondary" className="mr-2" onClick={() => { setServerMode(false); setError(null); }}>{t('login.back')}</Button>}
          <Button variant="secondary" onClick={onCancel}>{t('logic.confirm.cancel')}</Button>
        </div>
      </section>
    </div>
  );
}
