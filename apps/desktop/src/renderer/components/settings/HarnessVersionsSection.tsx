import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  HARNESS_KINDS,
  type HarnessRuntimeState,
  type HarnessKind,
  type HarnessRelease,
} from '../../../shared/harnessSettings';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import { harnessErrorKey } from './harnessErrorKey';

export const HARNESS_LABELS = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
  omp: 'OMP',
};
export const HARNESS_BUTTON =
  'min-h-8 rounded-full border border-[var(--settings-btn-secondary-border)] bg-[var(--settings-btn-secondary-bg)] px-3 py-1 text-13 text-[var(--settings-btn-secondary-text)] hover:bg-[var(--settings-menu-bg-hover)] disabled:cursor-not-allowed disabled:opacity-40';

export function HarnessVersionsSection() {
  const { t } = useTranslation();
  const phaseLabels: Record<HarnessRuntimeState['phase'], string> = {
    idle: '',
    ready: '',
    checking: t('settings.harness.phase.checking'),
    downloading: t('settings.harness.phase.downloading'),
    verifying: t('settings.harness.phase.verifying'),
    cancelled: t('settings.harness.phase.cancelled'),
    failed: t('settings.harness.phase.failed'),
  };
  const [states, setStates] = useState<Partial<Record<HarnessKind, HarnessRuntimeState>>>({});
  const [unavailable, setUnavailable] = useState(false);
  const [requestErrors, setRequestErrors] = useState<Partial<Record<HarnessKind, string>>>({});
  useEffect(() => {
    let active = true;
    const api = window.electronAPI?.maker.harness;
    if (!api) {
      setUnavailable(true);
      return;
    }
    const update = (state: HarnessRuntimeState) => {
      if (active) {
        setStates((prev) => ({ ...prev, [state.kind]: state }));
        setRequestErrors((prev) => ({ ...prev, [state.kind]: undefined }));
      }
    };
    const unsubscribe = api.onProgress(update);
    for (const kind of HARNESS_KINDS)
      void api
        .check(kind)
        .then(update)
        .catch(() => {
          if (active)
            setRequestErrors((prev) => ({ ...prev, [kind]: 'settings.harness.errors.check' }));
        });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  const invoke = async (kind: HarnessKind, release?: HarnessRelease) => {
    setRequestErrors((prev) => ({ ...prev, [kind]: undefined }));
    try {
      const api = window.electronAPI.maker.harness;
      const next = release ? await api.install({ kind, ...release }) : await api.check(kind, true);
      setStates((prev) => ({ ...prev, [kind]: next }));
    } catch (error) {
      const key = harnessErrorKey(extractIpcError(error)?.message, release ? undefined : 'check');
      setRequestErrors((prev) => ({ ...prev, [kind]: key }));
      toast.error(t(key));
    }
  };
  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex flex-col gap-1">
        <h2 className="text-16 font-medium text-[var(--settings-section-title)]">
          {t('settings.harness.versions')}
        </h2>
        <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">
          {t('settings.harness.versionsDescription')}
        </p>
      </div>
      {unavailable && (
        <p role="alert" className="text-13 text-[var(--settings-error-text)]">
          {t('settings.harness.runtimeFailed')}
        </p>
      )}
      <div className="divide-y divide-[var(--settings-theme-card-border)] rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]">
        {HARNESS_KINDS.map((kind) => {
          const state = states[kind];
          const installing = state?.phase === 'downloading' || state?.phase === 'verifying';
          const busy =
            (!state && !requestErrors[kind]) || installing || state?.phase === 'checking';
          const errorKey =
            requestErrors[kind] ??
            (state?.error ? harnessErrorKey(state.error, state.failureStage) : null);
          const showStatus =
            errorKey || state?.restartRequired || (state && phaseLabels[state.phase]);
          return (
            <div key={kind} className="flex flex-col gap-2 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-13 text-[var(--settings-section-title)]">
                  <span className="font-medium">{HARNESS_LABELS[kind]}</span>
                  <span className="ml-3 tabular-nums">
                    {state?.currentVersion ?? t('settings.about.version.notReady')}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={HARNESS_BUTTON}
                    disabled={busy}
                    onClick={() => void invoke(kind)}
                  >
                    {t('settings.harness.check')}
                  </button>
                  {state?.upstream && (
                    <button
                      type="button"
                      className={HARNESS_BUTTON}
                      disabled={
                        busy ||
                        (state.selectedVersion ?? state.currentVersion) === state.upstream.version
                      }
                      onClick={() => void invoke(kind, state.upstream!)}
                    >
                      {t('settings.harness.install', { version: state.upstream.version })}
                    </button>
                  )}
                  {state?.baseline && (
                    <button
                      type="button"
                      className={HARNESS_BUTTON}
                      disabled={busy || state.selectedVersion === state.baseline.version}
                      onClick={() => void invoke(kind, state.baseline!)}
                    >
                      {t('settings.harness.restore', { version: state.baseline.version })}
                    </button>
                  )}
                  {installing && (
                    <button
                      type="button"
                      className={HARNESS_BUTTON}
                      onClick={() => {
                        void window.electronAPI.maker.harness
                          .cancel(kind)
                          .catch(() => toast.error(t('settings.harness.runtimeFailed')));
                      }}
                    >
                      {t('settings.harness.cancel')}
                    </button>
                  )}
                </div>
              </div>
              {showStatus && (
                <div aria-live="polite" className="text-12 text-[var(--settings-section-desc)]">
                  {state && !errorKey && !['idle', 'ready'].includes(state.phase) && (
                    <span>
                      {phaseLabels[state.phase]}{' '}
                      {state.percent === null ? '' : Math.round(state.percent) + '%'}
                    </span>
                  )}
                  {errorKey && <p role="alert">{t(errorKey)}</p>}
                  {state?.restartRequired && (
                    <p>
                      {t('settings.harness.restartRequired', { version: state.selectedVersion })}
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
