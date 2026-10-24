import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { AgentPresentationStatus } from '../../../shared/agentPresentation';

export function AgentPresentationUnavailable({ reason }: { reason?: Extract<AgentPresentationStatus, { supported: false }>['reason'] }) {
  const { t } = useTranslation();
  const description = t(reason === 'task-busy' ? 'ccAgent.presentation.startupUnavailable.busy'
    : reason === 'unsupported-service' ? 'ccAgent.presentation.startupUnavailable.unsupported' : 'ccAgent.presentation.startupUnavailable.startup');
  return <span role="status" title={description} aria-label={description} className="shrink-0 text-11 text-[var(--text-secondary)]">
    {t('ccAgent.presentation.startupUnavailable.label')}
  </span>;
}

export function AgentPresentationSwitch({ mode, onChange, tuiUnavailable, preparing }: {
  mode: 'gui' | 'tui'; onChange(mode: 'gui' | 'tui'): void;
  tuiUnavailable?: string;
  preparing?: boolean;
}) {
  const { t } = useTranslation();
  const labels = { gui: t('ccAgent.presentation.gui'), tui: t('ccAgent.presentation.tui') };
  const descriptions = { gui: t('ccAgent.presentation.guiDescription'), tui: t('ccAgent.presentation.tuiDescription') };
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-full bg-[var(--surface-chip)] p-0.5"
      role="group" aria-label={t('ccAgent.presentation.label')}
      onKeyDown={(event) => {
        // Keep this control keyboard-operable inside the desktop's global
        // mouse-first Tab gate, without changing composer/native shortcuts.
        if (event.key === 'Tab') event.stopPropagation();
        const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
        const index = buttons.indexOf(event.target as HTMLButtonElement);
        const next = event.key === 'ArrowLeft' ? (index + buttons.length - 1) % buttons.length
          : event.key === 'ArrowRight' ? (index + 1) % buttons.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1;
        if (next < 0 || index < 0) return;
        event.preventDefault(); event.stopPropagation(); buttons[next]?.focus();
      }}>
      {(['gui', 'tui'] as const).map((item) => (
        <button key={item} type="button" aria-pressed={mode === item}
          aria-label={descriptions[item]}
          aria-busy={item === 'tui' && preparing || undefined}
          aria-disabled={item === 'tui' && !!tuiUnavailable || undefined}
          title={item === 'tui' ? tuiUnavailable : undefined}
          onClick={() => { if (item !== 'tui' || !tuiUnavailable) onChange(item); }}
          className={cn('min-h-7 min-w-10 rounded-full px-2 text-11 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            mode === item ? 'bg-[var(--text-primary)] text-[var(--panel-bg)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]')}>
          {item === 'tui' && preparing ? t('ccAgent.presentation.preparing') : labels[item]}
        </button>
      ))}
    </div>
  );
}
