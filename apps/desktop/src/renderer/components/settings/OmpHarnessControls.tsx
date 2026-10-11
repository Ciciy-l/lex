import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { connectedProvidersForAgent } from '@cindy/model-providers';
import type { OmpHarnessSettings, OmpHarnessState } from '../../../shared/harnessSettings';
import { useProviders } from '@/hooks/useProviders';
import { useMemorySettings } from '@/hooks/useMemorySettings';
import { Switch } from '@/components/ui/switch';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { toast } from '@/lib/toast';
import { DefaultOverrideControls } from './DefaultOverrideControls';
import { HARNESS_BUTTON } from './HarnessVersionsSection';

export function useOmpHarnessSettings() {
  const { t } = useTranslation();
  const [state, setState] = useState<OmpHarnessState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const active = useRef(true);
  const pendingRef = useRef(false);
  const load = useCallback(async () => {
    try {
      const next = await window.electronAPI.maker.ompHarness.get();
      if (active.current) {
        setState(next);
        setError(false);
      }
    } catch {
      if (active.current) setError(true);
    }
  }, []);
  useEffect(() => {
    active.current = true;
    void load();
    return () => {
      active.current = false;
    };
  }, [load]);
  const run = async (
    action: () => Promise<OmpHarnessState | void>,
    successKey = 'settings.harness.nextSession',
  ) => {
    if (!active.current || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      const next = await action();
      if (active.current) {
        if (next) setState(next);
        toast.success(t(successKey));
      }
    } catch (err) {
      if (active.current)
        toast.error(
          err instanceof Error && err.message.includes('OMP_MEMORY_BUSY')
            ? t('settings.harness.memoryBusy')
            : t('settings.harness.saveFailed'),
        );
    } finally {
      pendingRef.current = false;
      if (active.current) setPending(false);
    }
  };
  return { state, pending, error, load, run };
}
type Controller = ReturnType<typeof useOmpHarnessSettings>;
type Group = 'memory' | 'subagents' | 'compaction';
const KEYS: Record<Group, (keyof OmpHarnessSettings)[]> = {
  memory: ['unifiedMemory', 'nativeMemory'],
  subagents: ['subagentModel', 'maxConcurrency', 'maxRecursionDepth'],
  compaction: ['compactionEnabled', 'compactionThreshold', 'keepRecentTokens'],
};
const inputClass =
  'min-h-8 w-40 rounded-lg border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-3 py-1 text-13 text-[var(--settings-input-text)]';
export function OmpHarnessControls({
  group,
  controller,
}: {
  group: Group;
  controller: Controller;
}) {
  const { t } = useTranslation();
  const { makerEnabled } = useMemorySettings();
  const { providers } = useProviders();
  const { confirm } = useConfirmDialog();
  const { state, pending, error, load, run } = controller;
  const settings = state?.value;
  const save = (patch: Partial<OmpHarnessSettings>) => {
    if (state)
      void run(() => window.electronAPI.maker.ompHarness.set(patch, state.ownerGeneration));
  };
  const toggle = (
    key: 'nativeMemory' | 'unifiedMemory' | 'compactionEnabled',
    disabled = false,
  ) => (
    <div className="flex items-center justify-between gap-4">
      <label htmlFor={'omp-' + key} className="text-13 text-[var(--settings-section-title)]">
        {t('settings.harness.' + key)}
      </label>
      <Switch
        id={'omp-' + key}
        checked={settings?.[key] ?? false}
        disabled={!settings || pending || disabled}
        onCheckedChange={(value) => save({ [key]: value })}
      />
    </div>
  );
  const number = (
    key: 'maxConcurrency' | 'maxRecursionDepth' | 'compactionThreshold' | 'keepRecentTokens',
    min: number,
    max: number,
  ) => (
    <NumericSetting
      key={key + ':' + settings?.[key]}
      label={t('settings.harness.' + key)}
      value={settings?.[key] ?? null}
      min={min}
      max={max}
      disabled={!settings || pending}
      onSave={(value) => save({ [key]: value })}
    />
  );
  const models = [
    ...new Set(
      connectedProvidersForAgent(providers, 'omp').flatMap((provider) =>
        (provider.models.omp ?? []).map((model) => model.id),
      ),
    ),
  ];
  if (settings?.subagentModel && !models.includes(settings.subagentModel))
    models.unshift(settings.subagentModel);
  return (
    <div className="mt-3 flex flex-col gap-4 rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-13 font-medium text-[var(--settings-section-title)]">OMP</h3>
        <DefaultOverrideControls
          isCustomized={
            state?.customizedKeys.some((key) =>
              KEYS[group].includes(key as keyof OmpHarnessSettings),
            ) ?? false
          }
          disabled={pending || !state}
          onReset={() => {
            if (state)
              void run(() =>
                window.electronAPI.maker.ompHarness.reset(KEYS[group], state.ownerGeneration),
              );
          }}
        />
      </div>
      {error && (
        <div role="alert" className="text-13 text-[var(--settings-error-text)]">
          {t('settings.harness.loadFailed')}{' '}
          <button type="button" className={HARNESS_BUTTON} onClick={() => void load()}>
            {t('settings.harness.retry')}
          </button>
        </div>
      )}
      {group === 'memory' && (
        <>
          {toggle('unifiedMemory', !makerEnabled)}
          {toggle('nativeMemory', makerEnabled)}
          <p className="text-13 text-[var(--settings-section-desc)]">
            {t('settings.harness.nativeMemoryDescription')}
          </p>
          {makerEnabled && (
            <p className="text-13 text-[var(--settings-section-desc)]">
              {t('settings.harness.nativeMemoryPaused')}
            </p>
          )}
          <button
            type="button"
            className={HARNESS_BUTTON + ' self-start'}
            disabled={!settings || pending}
            onClick={async () => {
              const ok = await confirm({
                title: t('settings.harness.clearMemory'),
                description: t('settings.harness.clearMemoryDescription'),
                confirmText: t('settings.harness.clearMemory'),
                cancelText: t('settings.harness.cancel'),
              });
              if (ok && state)
                void run(
                  () => window.electronAPI.maker.ompHarness.clearMemory(state.ownerGeneration),
                  'settings.harness.memoryCleared',
                );
            }}
          >
            {t('settings.harness.clearMemory')}
          </button>
        </>
      )}
      {group === 'subagents' && (
        <>
          <label className="flex items-center justify-between gap-4 text-13 text-[var(--settings-section-title)]">
            {t('settings.harness.subagentModel')}
            <select
              className={inputClass}
              value={settings?.subagentModel ?? ''}
              disabled={!settings || pending}
              onChange={(event) => save({ subagentModel: event.target.value || null })}
            >
              <option value="">{t('settings.harness.inheritModel')}</option>
              {models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
          <p className="text-13 text-[var(--settings-section-desc)]">
            {t('settings.harness.subagentDescription')}
          </p>
          {number('maxConcurrency', 0, 128)}
          {number('maxRecursionDepth', 0, 16)}
        </>
      )}
      {group === 'compaction' && (
        <>
          {toggle('compactionEnabled')}
          {number('compactionThreshold', 50, 95)}
          {number('keepRecentTokens', 0, 1_000_000)}
          <p className="text-13 text-[var(--settings-section-desc)]">
            {t('settings.harness.compactionDescription')}
          </p>
        </>
      )}
      <p className="text-12 text-[var(--settings-section-desc)]">
        {t('settings.harness.nextSession')}
      </p>
    </div>
  );
}
function NumericSetting({
  label,
  value,
  min,
  max,
  disabled,
  onSave,
}: {
  label: string;
  value: number | null;
  min: number;
  max: number;
  disabled: boolean;
  onSave: (next: number | null) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  const commit = () => {
    const next = draft === '' ? null : Number(draft);
    if (next !== null && (!Number.isInteger(next) || next < min || next > max)) {
      setDraft(value === null ? '' : String(value));
      toast.error(t('settings.harness.invalidRange', { min, max }));
      return;
    }
    if (next !== value) onSave(next);
  };
  return (
    <label className="flex items-center justify-between gap-4 text-13 text-[var(--settings-section-title)]">
      {label}
      <input
        className={inputClass}
        type="number"
        min={min}
        max={max}
        step={1}
        disabled={disabled}
        value={draft}
        placeholder={t('settings.harness.nativeDefault')}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
    </label>
  );
}
