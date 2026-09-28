import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

/** Resolve a bounded host activity token to existing mobile copy. */
export function useCompanionGenerationCopy({ phase, active }: {
  deviceId: string;
  botId: string;
  phase: string | null;
  active: boolean;
  turnId: string;
}): string | null {
  const { t } = useTranslation();
  return useMemo(() => {
    if (!active) return null;
    if (!phase || phase === 'thinking') return t('devices.companions.working.thinking');
    return phase;
  }, [active, phase, t]);
}
