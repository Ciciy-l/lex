import { Zap } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tip } from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/** The owning composer persists Fast; this control never keeps a second preference. */
export function ComposerFastButton({ enabled, disabled = false, onChange }: {
  enabled: boolean;
  disabled?: boolean;
  onChange: (enabled: boolean) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const label = t(enabled ? 'newChat.modelSelector.fastShortcut.disable' : 'newChat.modelSelector.fastShortcut.enable');
  const unavailable = disabled || pending;
  return (
    <Tip text={unavailable ? t('newChat.modelSelector.fastShortcut.unavailable') : label} side="top">
      <span className="inline-flex shrink-0 rounded-full">
        <button
          type="button"
          aria-label={label}
          aria-pressed={enabled}
          aria-busy={pending}
          disabled={unavailable}
          onMouseDown={(event) => event.preventDefault()}
          onClick={async () => {
            if (unavailable || inFlight.current) return;
            inFlight.current = true;
            setPending(true);
            try {
              await onChange(!enabled);
            } catch {
              toast.error(t('newChat.chatInput.remoteSwitchFailed'));
            } finally {
              inFlight.current = false;
              setPending(false);
            }
          }}
          className={cn(
            'flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full border border-transparent transition-colors',
            'hover:border-[var(--border-default)] hover:bg-[var(--surface-hover-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50',
            enabled ? 'bg-[var(--surface-chip)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)]',
          )}
        >
          <Zap size={14} fill={enabled ? 'currentColor' : 'none'} aria-hidden="true" />
        </button>
      </span>
    </Tip>
  );
}
