import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { useUserPrompt } from '@/hooks/useUserPrompt';
import { USER_PROMPT_MAX_LENGTH } from '@/lib/userPrompt.constants';
import { toast } from '@/lib/toast';
import { PROMPT_ENGINES, userPromptFits, type PromptScope } from '@/lib/userPromptStore';

export function UserPromptSection() {
  const { t } = useTranslation();
  const [scope, setScope] = useState<PromptScope>('common');
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          {t('settings.personalization.title')}
        </h2>
        <label className="text-13 text-[var(--settings-section-title)]">
          <span className="sr-only">{t('settings.harness.promptScope')}</span>
          <select
            value={scope}
            onChange={(event) => setScope(event.target.value as PromptScope)}
            className="min-h-8 rounded-full border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-3 py-1 text-[var(--settings-input-text)]"
          >
            <option value="common">{t('settings.harness.commonPrompt')}</option>
            {PROMPT_ENGINES.map((engine) => (
              <option key={engine} value={engine}>
                {engine === 'claude-code'
                  ? 'Claude Code'
                  : engine === 'omp'
                    ? 'OMP'
                    : engine === 'pi'
                      ? 'Pi'
                      : 'Codex'}
              </option>
            ))}
          </select>
        </label>
      </div>
      <PromptEditor key={scope} scope={scope} />
    </div>
  );
}

function PromptEditor({ scope }: { scope: PromptScope }) {
  const { value, owner, setValue } = useUserPrompt(scope);
  const { t } = useTranslation();

  const [draft, setDraft] = useState(value);

  // 外部 storage 变化（其他 window 实例 setValue 触发的 storage event）时刷新草稿。
  // 单 Electron 窗口里几乎不会触发，留作兜底。
  useEffect(() => {
    setDraft(value);
  }, [value, owner]);

  const length = draft.length;
  const overLimit = !userPromptFits(scope, draft);
  const dirty = draft !== value;
  const canSave = dirty && !overLimit;

  const handleSave = useCallback(() => {
    if (!canSave) return;
    try {
      setValue(draft);
      toast.success(t('settings.personalization.toast.saved'));
    } catch {
      toast.error(t('settings.harness.saveFailed'));
    }
  }, [canSave, draft, setValue, t]);

  const counter = useMemo(
    () => `${length.toLocaleString()} / ${USER_PROMPT_MAX_LENGTH.toLocaleString()}`,
    [length],
  );

  return (
    <div className="flex flex-col gap-[14px]">
      <div
        className={cn(
          'flex flex-col gap-3 rounded-xl p-4',
          'bg-[var(--settings-theme-card-bg)]',
          'border border-[var(--settings-theme-card-border)]',
        )}
      >
        <div className="flex flex-col gap-1">
          <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">
            {t('settings.harness.promptDescription')}
          </p>
        </div>

        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('settings.personalization.placeholder')}
          aria-label={t('settings.personalization.ariaLabel')}
          rows={7}
          className={cn(
            'min-h-[160px] w-full resize-y rounded-xl',
            'p-4',
            'bg-[var(--settings-input-bg)]',
            'border border-[var(--settings-input-border)]',
            'text-13 leading-[1.6] text-[var(--settings-input-text)]',
            'placeholder:font-normal placeholder:text-[var(--settings-input-placeholder)] placeholder:opacity-45',
            'outline-none focus:border-[var(--settings-input-border-focus)]',
            'transition-colors',
          )}
          style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
        />

        <div className="flex items-center justify-between gap-3">
          <p
            className={cn(
              'text-12 tabular-nums',
              overLimit
                ? 'text-[var(--settings-error-text)]'
                : 'text-[var(--settings-source-meta)]',
            )}
            style={{ letterSpacing: '0.12px' }}
            aria-live="polite"
          >
            {counter}
            {overLimit ? t('settings.personalization.overLimit') : ''}
          </p>

          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className={cn(
              'flex h-8 items-center justify-center gap-1.5 rounded-full px-[18px]',
              'bg-[var(--settings-btn-primary-bg)]',
              'border border-[var(--settings-btn-primary-border)]',
              'text-13 font-medium text-[var(--settings-btn-primary-text)]',
              'hover:bg-[var(--settings-btn-primary-hover-bg)]',
              'transition-colors',
              !canSave && 'cursor-not-allowed opacity-40',
            )}
          >
            {t('settings.personalization.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
