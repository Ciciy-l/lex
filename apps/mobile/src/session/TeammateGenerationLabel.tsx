import { WorkingStatusText } from './WorkingStatusText';
import { fontWeight, lineHeight } from '@/theme/tokens';
import { readWorkingPhase } from '@cindy/maker-shared';
import type { RemoteResourceDisplay } from '@cindy/device-link';
import { Text } from '@/components/AppText';
import { useTheme, typeScale } from '@/theme';
import { useCompanionGenerationCopy } from './useCompanionGenerationCopy';

export function TeammateGenerationLabel({ deviceId, botId, generation }: {
  deviceId: string; botId: string; generation: NonNullable<RemoteResourceDisplay['generation']>;
}) {
  const { colors } = useTheme();
  const label = useCompanionGenerationCopy({ deviceId, botId, phase: readWorkingPhase(generation.phase) ?? 'processing',
    active: true, turnId: String(generation.startedAt) });
  // A transient process note stays tertiary so it never outranks a real new reply. No italic:
  // CJK has no true italic and the synthetic slant reads as a rendering glitch.
  return <WorkingStatusText key={generation.startedAt} text={label ?? ''} style={{ color: colors.textTertiary,
    fontSize: typeScale.bodySmall, fontWeight: fontWeight.regular, lineHeight: lineHeight.subtitle }} />;
}
