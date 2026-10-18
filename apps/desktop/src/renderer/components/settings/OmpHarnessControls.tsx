import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { OmpHarnessSettings, OmpHarnessState } from '../../../shared/harnessSettings';
import { useProviders } from '@/hooks/useProviders';
import { useMemorySettings } from '@/hooks/useMemorySettings';
import { OmpMark } from '@/components/icons/OmpMark';
import { ModelSelector } from '@/components/new-chat/ModelSelector';
import { Tip } from '@/components/ui/tooltip';
import { Switch } from '@/components/ui/switch';
import { FormField } from '@/components/ui/form-field';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { toast } from '@/lib/toast';
import { DefaultOverrideControls } from './DefaultOverrideControls';
import { HARNESS_BUTTON } from './HarnessVersionsSection';
import { SettingsTextInput } from './SettingsTextInput';
import { CompactionThresholdControl } from './CompactionThresholdControl';
import { useSettingsSearchNavigation } from './SettingsSearchNavigation';

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
    successKey: string | null = 'settings.harness.nextSession',
  ): Promise<boolean> => {
    if (!active.current || pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    try {
      const next = await action();
      if (!active.current) return false;
      if (next) setState(next);
      if (successKey) toast.success(t(successKey));
      return true;
    } catch (err) {
      if (active.current)
        toast.error(
          err instanceof Error && err.message.includes('OMP_MEMORY_BUSY')
            ? t('settings.harness.memoryBusy')
            : t('settings.harness.saveFailed'),
        );
      return false;
    } finally {
      pendingRef.current = false;
      if (active.current) setPending(false);
    }
  };
  return { state, pending, error, load, run };
}

type Controller = ReturnType<typeof useOmpHarnessSettings>;
type Group = 'memory' | 'subagents' | 'compaction';
export const OMP_MEMORY_KEYS: (keyof OmpHarnessSettings)[] = ['unifiedMemory', 'nativeMemory'];
const KEYS: Record<Group, (keyof OmpHarnessSettings)[]> = {
  memory: OMP_MEMORY_KEYS,
  subagents: ['subagentModel', 'maxConcurrency', 'maxRecursionDepth'],
  compaction: ['compactionEnabled', 'compactionThreshold', 'keepRecentTokens'],
};
const ADVANCED_KEYS: Record<Group, (keyof OmpHarnessSettings)[]> = {
  memory: ['nativeMemory'],
  subagents: ['maxConcurrency', 'maxRecursionDepth'],
  compaction: ['compactionEnabled', 'keepRecentTokens'],
};

function useAdvancedSettings(group: Group, customized: boolean) {
  const { t } = useTranslation();
  const { entry, activation } = useSettingsSearchNavigation();
  const [expanded, setExpanded] = useState(false);
  const target = 'settings-omp-' + group + '-advanced';
  useLayoutEffect(() => {
    if (entry?.targetId === target) setExpanded(true);
  }, [entry?.targetId, activation, target]);
  return {
    expanded,
    target,
    trigger: (
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={target}
        onClick={() => setExpanded((value) => !value)}
        className="flex min-h-8 shrink-0 items-center gap-2 self-start whitespace-nowrap rounded-full px-2 text-12 text-[var(--settings-section-desc)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {t('settings.harness.advanced')}
        {customized && (
          <span className="rounded-full bg-[var(--surface-chip)] px-2 py-1 text-11 text-[var(--text-secondary)]">
            {t('settings.defaults.customizedBadge')}
          </span>
        )}
      </button>
    ),
  };
}

/** Memory/Subagent render inside their shared card; compaction follows its sibling cards. */
export function OmpHarnessControls({
  group,
  controller,
}: {
  group: Group;
  controller: Controller;
}) {
  const { t } = useTranslation();
  const { makerEnabled } = useMemorySettings();
  const { loading: providersLoading } = useProviders();
  const { confirm } = useConfirmDialog();
  const { state, pending, error, load, run } = controller;
  const settings = state?.value;
  const disabled = !settings || pending;
  const labels = {
    nativeMemory: t('settings.harness.nativeMemory'),
    compactionEnabled: t('settings.harness.compactionEnabled'),
    maxConcurrency: t('settings.harness.maxConcurrency'),
    maxRecursionDepth: t('settings.harness.maxRecursionDepth'),
    keepRecentTokens: t('settings.harness.keepRecentTokens'),
  };
  const customized = (keys: (keyof OmpHarnessSettings)[]) =>
    state?.customizedKeys.some((key) => keys.includes(key as keyof OmpHarnessSettings)) ?? false;
  const save = (patch: Partial<OmpHarnessSettings>) =>
    state
      ? run(() => window.electronAPI.maker.ompHarness.set(patch, state.ownerGeneration))
      : Promise.resolve(false);
  const reset = (
    <DefaultOverrideControls
      isCustomized={customized(KEYS[group])}
      disabled={disabled}
      alwaysVisible={group === 'subagents'}
      showCustomizedBadge={group !== 'subagents'}
      onReset={() => {
        if (state)
          void run(
            () => window.electronAPI.maker.ompHarness.reset(KEYS[group], state.ownerGeneration),
            'settings.defaults.restored',
          );
      }}
    />
  );
  const clearMemory = async () => {
    if (disabled || !state) return;
    const ok = await confirm({
      title: t('settings.harness.clearMemory'),
      description: t('settings.harness.clearMemoryDescription'),
      confirmText: t('settings.harness.clearMemory'),
      cancelText: t('settings.harness.cancel'),
    });
    if (ok)
      void run(
        () => window.electronAPI.maker.ompHarness.clearMemory(state.ownerGeneration),
        'settings.harness.memoryCleared',
      );
  };
  const advanced = useAdvancedSettings(group, customized(ADVANCED_KEYS[group]));
  const toggle = (key: 'nativeMemory' | 'compactionEnabled', inactive = false) => (
    <div className="flex items-center justify-between gap-4">
      <label htmlFor={'omp-' + key} className="text-13 text-[var(--settings-section-title)]">
        {labels[key]}
      </label>
      <Switch
        id={'omp-' + key}
        checked={settings?.[key] ?? false}
        disabled={disabled || inactive}
        onCheckedChange={(value) => {
          void save({ [key]: value });
        }}
      />
    </div>
  );
  const number = (
    key: 'maxConcurrency' | 'maxRecursionDepth' | 'keepRecentTokens',
    min: number,
    max: number,
  ) => (
    <NumericSetting
      id={'omp-' + key}
      label={labels[key]}
      value={settings?.[key] ?? null}
      snapshot={state}
      min={min}
      max={max}
      disabled={disabled || (group === 'compaction' && !settings?.compactionEnabled)}
      onSave={(value) => save({ [key]: value })}
    />
  );
  return (
    <div
      data-omp-group={group}
      className={
        group === 'compaction'
          ? 'flex flex-col gap-[14px] rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] p-4'
          : 'flex flex-col gap-3 border-t border-[var(--settings-theme-card-border)] px-4 py-[14px]'
      }
    >
      {group === 'compaction' ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-14 font-medium text-[var(--text-primary)]">
            {t('settings.compaction.card.label')}
          </p>
          <div className="flex items-center gap-2">
            {advanced.trigger}
            <span className="shrink-0 rounded-full bg-[var(--surface-chip)] px-2.5 py-1 text-11 font-medium leading-none text-[var(--text-secondary)]">
              OMP
            </span>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div
            className={
              group === 'memory'
                ? 'flex min-w-0 flex-1 items-center gap-3'
                : 'flex w-[150px] shrink-0 items-center gap-2'
            }
          >
            <div
              className={
                group === 'memory'
                  ? 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--settings-input-bg)]'
                  : 'shrink-0'
              }
            >
              <OmpMark
                size={group === 'memory' ? 18 : 16}
                className="text-[var(--settings-section-title)]"
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-14 font-medium text-[var(--settings-section-title)]">OMP</span>
              {group === 'memory' && (
                <span className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">
                  {t('settings.harness.unifiedMemory')}
                </span>
              )}
            </div>
          </div>
          <div
            className={
              group === 'subagents'
                ? 'flex min-w-0 flex-1 basis-48 items-center gap-2'
                : 'flex shrink-0 items-center gap-2'
            }
          >
            {group === 'memory' && advanced.trigger}
            {group === 'memory' ? (
              <Switch
                checked={settings?.unifiedMemory ?? false}
                disabled={disabled || !makerEnabled}
                onCheckedChange={(value) => {
                  void save({ unifiedMemory: value });
                }}
                aria-label={'OMP · ' + t('settings.harness.unifiedMemory')}
              />
            ) : (
              <div className="min-w-0 flex-1">
                <ModelSelector
                  modelId={settings?.subagentModel ?? ''}
                  effort=""
                  vendorKey="omp"
                  unifiedAgents={['omp']}
                  onModelChange={(model) => save({ subagentModel: model })}
                  onEffortChange={() => undefined}
                  configurationEnabled={false}
                  disabled={disabled || providersLoading}
                  triggerVariant="field"
                  popoverSide="bottom"
                  ariaContext={'OMP · ' + t('settings.harness.subagentModel')}
                  unknownModelLabel={(id) => id}
                  fallbackOption={{
                    active: !settings?.subagentModel,
                    label: t('settings.harness.inheritModel'),
                    onSelect: () => save({ subagentModel: null }),
                  }}
                />
              </div>
            )}
            {group === 'memory' ? (
              <Tip text={t('settings.harness.clearMemory')}>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={t('settings.harness.clearMemory')}
                  onClick={() => void clearMemory()}
                  className="flex h-[30px] w-[30px] items-center justify-center rounded-lg text-[var(--settings-section-desc)] hover:bg-[var(--settings-input-bg)] hover:text-[var(--settings-section-title)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                >
                  <RotateCcw size={16} />
                </button>
              </Tip>
            ) : (
              reset
            )}
          </div>
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 text-13 text-[var(--settings-error-text)]"
        >
          {t('settings.harness.loadFailed')}
          <button
            type="button"
            className={HARNESS_BUTTON}
            disabled={pending}
            onClick={() => void load()}
          >
            {t('settings.harness.retry')}
          </button>
        </div>
      )}
      {group === 'subagents' && (
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="min-w-0 flex-1 basis-64 text-12 leading-[1.5] text-[var(--settings-section-desc)]">
            {t('settings.harness.subagentDescription')}
          </p>
          {advanced.trigger}
        </div>
      )}
      {group === 'compaction' && (
        <>
          <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">
            {t('settings.harness.compactionDescription')}
          </p>
          <OmpCompactionThreshold
            value={settings?.compactionThreshold ?? null}
            snapshot={state}
            disabled={disabled || !settings?.compactionEnabled}
            onSave={(compactionThreshold) => save({ compactionThreshold })}
          />
        </>
      )}
      {advanced.expanded && (
        <div
          id={advanced.target}
          className="flex flex-col gap-3 border-t border-[var(--settings-theme-card-border)] pt-3"
        >
          {group === 'memory' && (
            <>
              {toggle('nativeMemory', makerEnabled)}
              <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">
                {t('settings.harness.nativeMemoryDescription')}
              </p>
              {makerEnabled && (
                <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">
                  {t('settings.harness.nativeMemoryPaused')}
                </p>
              )}
              <div className="flex justify-end">{reset}</div>
            </>
          )}
          {group === 'subagents' && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {number('maxConcurrency', 0, 128)}
              {number('maxRecursionDepth', 0, 16)}
              <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)] sm:col-span-2">
                {t('settings.harness.subagentAdvancedHint')}
              </p>
            </div>
          )}
          {group === 'compaction' && (
            <>
              {toggle('compactionEnabled')}
              {number('keepRecentTokens', 0, 1_000_000)}
              <div className="flex justify-end">{reset}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function OmpCompactionThreshold({
  value,
  snapshot,
  disabled,
  onSave,
}: {
  value: number | null;
  snapshot: OmpHarnessState | null;
  disabled: boolean;
  onSave: (value: number | null) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  const saved = useRef(value);
  saved.current = value;
  useEffect(() => {
    setDraft(value);
  }, [value, snapshot]);
  return (
    <CompactionThresholdControl
      value={draft}
      nativeDefault
      disabled={disabled}
      label={t('settings.harness.compactionThreshold')}
      onChange={setDraft}
      onCommit={async (next) => {
        if (disabled || next === saved.current) return;
        if (!(await onSave(next))) setDraft(saved.current);
      }}
    />
  );
}

function NumericSetting({
  id,
  label,
  value,
  snapshot,
  min,
  max,
  disabled,
  onSave,
}: {
  id: string;
  label: string;
  value: number | null;
  snapshot: OmpHarnessState | null;
  min: number;
  max: number;
  disabled: boolean;
  onSave: (next: number | null) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  const [invalid, setInvalid] = useState(false);
  const saving = useRef(false);
  const currentValue = useRef(value);
  currentValue.current = value;
  // Reset/reload responses also clear a rejected draft when the saved value is unchanged.
  useEffect(() => {
    setDraft(value === null ? '' : String(value));
    setInvalid(false);
  }, [value, snapshot]);
  const commit = async () => {
    if (disabled || saving.current) return;
    const next = draft.trim() === '' ? null : Number(draft);
    if (next !== null && (!Number.isInteger(next) || next < min || next > max)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (next === value) return;
    saving.current = true;
    try {
      if (!(await onSave(next)))
        setDraft(currentValue.current === null ? '' : String(currentValue.current));
    } finally {
      saving.current = false;
    }
  };
  return (
    <FormField
      id={id}
      label={label}
      error={invalid ? t('settings.harness.invalidRange', { min, max }) : undefined}
    >
      {(control) => (
        <SettingsTextInput
          {...control}
          type="text"
          inputMode="numeric"
          size="sm"
          className="w-full sm:max-w-64"
          value={draft}
          disabled={disabled}
          placeholder={t('settings.harness.nativeDefault')}
          onChange={(text) => {
            setDraft(text);
            setInvalid(false);
          }}
          onBlur={() => {
            void commit();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
      )}
    </FormField>
  );
}
