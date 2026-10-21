import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { WindowControls } from '@/components/title-bar/WindowControls';
import { WINDOW_DRAG_STYLE, WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';

/** Account-service choice only; credentials and the login flow remain in Main. */
export function LoginServiceSelection({
  onSelect,
  onCancel,
}: {
  onSelect: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();

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
        <h1 id="login-service-title" className="text-20 font-medium">{t('login.serviceSelection.title')}</h1>
        <p className="mt-2 text-13 leading-relaxed text-[var(--text-secondary)]">{t('login.serviceSelection.description')}</p>
        <Button autoFocus variant="secondary" size="lg" className="mt-6 w-full justify-between px-4" onClick={onSelect}>
          <span>Cindy</span><ArrowRight size={16} aria-hidden="true" />
        </Button>
        <div className="mt-6 flex justify-end">
          <Button variant="secondary" onClick={onCancel}>{t('logic.confirm.cancel')}</Button>
        </div>
      </section>
    </div>
  );
}
