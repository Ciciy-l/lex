import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export function AgentPresentationUnavailable() {
  const { t } = useTranslation();
  const description = t('ccAgent.presentation.startupUnavailable.startup');
  return <span role="status" title={description} aria-label={description} className="shrink-0 text-11 text-[var(--text-secondary)]">
    {t('ccAgent.presentation.startupUnavailable.label')}
  </span>;
}

export function AgentPresentationSwitch({ mode, onChange }: {
  mode: 'gui' | 'tui'; onChange(mode: 'gui' | 'tui'): void;
}) {
  const { t } = useTranslation();
  const labels = { gui: t('ccAgent.presentation.gui'), tui: t('ccAgent.presentation.tui') };
  const descriptions = { gui: t('ccAgent.presentation.guiDescription'), tui: t('ccAgent.presentation.tuiDescription') };
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-full bg-[var(--surface-chip)] p-0.5"
      role="group" aria-label={t('ccAgent.presentation.label')}>
      {(['gui', 'tui'] as const).map((item) => (
        <button key={item} type="button" aria-pressed={mode === item}
          aria-label={descriptions[item]}
          onClick={() => onChange(item)}
          className={cn('min-h-7 min-w-10 rounded-full px-2 text-11 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            mode === item ? 'bg-[var(--text-primary)] text-[var(--panel-bg)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]')}>
          {labels[item]}
        </button>
      ))}
    </div>
  );
}
