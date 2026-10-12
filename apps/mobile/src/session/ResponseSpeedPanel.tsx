import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useTranslation } from 'react-i18next';
import { responseSpeedActivity, responseSpeedHistory, type ResponseSpeedSnapshot } from '@cindy/maker-shared/usage-format';
import { Text } from '@/components/AppText';
import { ContextSheet, ContextSheetRow } from './ContextSheet';
import { fontWeight, iconStroke, radius, spacing, typeScale, lineHeight, useTheme, useThemedStyles, type ThemeColors } from '@/theme';

export function ResponseSpeedPanel({ speed }: { speed: ResponseSpeedSnapshot }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (speed.phase === 'complete') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [speed.phase, speed.sampledAt]);
  const time = Math.max(now, Date.now());
  const activity = responseSpeedActivity(speed, time);
  const history = responseSpeedHistory(speed, time);
  const label = t(activity === 'failed' ? 'session.screen.responseFailed'
    : activity === 'cancelled' ? 'session.screen.responseCancelled'
    : activity === 'retrying' ? 'session.screen.responseRetrying'
    : activity === 'complete' ? 'session.screen.lastGeneration'
    : activity === 'tool' ? 'session.screen.toolRunning'
    : activity === 'paused' ? 'session.screen.generationPaused'
    : activity === 'generating' ? 'session.screen.responseGenerating'
    : 'session.screen.responsePending');
  const rateText = (rate: number | null, estimated: boolean) => rate === null ? '—'
    : t(estimated ? 'session.screen.estimatedTokenRate' : 'session.screen.tokenRate', {
      rate: rate.toFixed(1).replace(/\.0$/, ''),
    });
  const samples = history.samples;
  const first = samples[0]?.durationMs ?? 0;
  const span = (samples.at(-1)?.durationMs ?? 0) - first;
  const ceiling = Math.max(1, ...samples.map(sample => sample.rate));
  const curve = samples.map((sample, i) => (i ? 'L' : 'M')
    + (span > 0 ? 4 + (sample.durationMs - first) / span * 292 : 296)
    + ',' + (76 - sample.rate / ceiling * 68)).join(' ');
  const output = speed.estimated ? t('session.screen.estimatedValue', { value: speed.outputTokens }) : String(speed.outputTokens);
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel={t('session.screen.rateHistory')}
      accessibilityState={{ expanded: open }} onPress={() => setOpen(true)}
      style={({ pressed }) => [styles.trigger, pressed && styles.triggerPressed]}
      testID="session.responseSpeedTrigger">
      <Text style={styles.label} numberOfLines={1}>{label}</Text>
      {history.latestRate !== null && <Text style={styles.label}>{rateText(history.latestRate, speed.phase !== 'complete' || speed.estimated)}</Text>}
    </Pressable>
    <ContextSheet visible={open} onClose={() => setOpen(false)} title={t('session.screen.rateHistory')}
      keyboardAvoidingBehavior={undefined} testID="session.responseSpeedPanel">
      <View style={styles.card}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.rate}>{rateText(history.latestRate, speed.phase !== 'complete' || speed.estimated)}</Text>
        <Svg width="100%" height={80} viewBox="0 0 300 80" accessibilityLabel={t('session.screen.rateHistory')}>
          <Path d="M4 76H296" stroke={colors.border} />
          {samples.length > 1 && <Path d={curve} stroke={colors.textPrimary} strokeWidth={iconStroke.regular} fill="none" />}
        </Svg>
        <Text style={styles.label}>{t('session.screen.averageRate')}: {rateText(speed.averageRate, speed.estimated)}</Text>
        <Text style={styles.label} testID="session.responseSpeedOutput">{t('session.screen.outputTotal')}: {t('session.screen.tokenCount', { tokens: output })}</Text>
        <Text style={styles.label}>{t('session.screen.observedPeak')}: {samples.length ? rateText(history.peak, true) : '—'}</Text>
        <Text style={styles.label}>{t(speed.waitOrigin === 'stream' ? 'session.screen.streamWait' : 'session.screen.firstResponse')}: {speed.firstResponseMs === null ? '—' : t('session.screen.waitSeconds', { seconds: (speed.firstResponseMs / 1000).toFixed(1) })}</Text>
        <Text style={styles.description}>{t('session.screen.tokenRateDescription')}</Text>
        <Text style={styles.description}>{t(speed.waitOrigin === 'stream' ? 'session.screen.streamWaitDescription' : 'session.screen.turnWaitDescription')}</Text>
      </View>
      <ContextSheetRow icon={null} label={t('shared.closePanel')} onPress={() => setOpen(false)} />
    </ContextSheet>
  </>;
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    trigger: { minHeight: 44, minWidth: 44, maxWidth: '100%', borderRadius: radius.pill,
      flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.sm },
    triggerPressed: { backgroundColor: colors.surfaceChip },
    card: { padding: spacing.lg, gap: spacing.sm, borderWidth: 1, borderColor: colors.border,
      borderRadius: radius.container, backgroundColor: colors.surfaceElevated },
    label: { color: colors.textSecondary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
    rate: { color: colors.textPrimary, fontSize: typeScale.title, lineHeight: lineHeight.title, fontWeight: fontWeight.medium },
    description: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  });
}
