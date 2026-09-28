import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SheetModal } from './SheetModal';
import { Text } from '@/components/AppText';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

/**
 * A small companion-management sheet built on the repository's standard SheetModal shell.
 * It intentionally owns no data or action state; callers keep drafts and operation identity.
 */
export function CompanionSheet({
  visible,
  title,
  onClose,
  onClosed,
  preventDismiss = false,
  testID,
  children,
}: {
  visible: boolean;
  title: string;
  onClose(): void;
  onClosed?(): void;
  preventDismiss?: boolean;
  testID?: string;
  children: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const dismiss = preventDismiss ? () => undefined : onClose;
  return <SheetModal
    visible={visible}
    onRequestClose={dismiss}
    onBackdropPress={dismiss}
    onClosed={onClosed}
    backdropTestID={testID ? [testID, 'backdrop'].join('.') : undefined}
  >
    <View style={[styles.panel, { backgroundColor: colors.sheetSurface }]} testID={testID}>
      <Text accessibilityRole="header" numberOfLines={1} style={styles.title}>{title}</Text>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        {children}
      </ScrollView>
    </View>
  </SheetModal>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  panel: {
    borderTopLeftRadius: radius.container,
    borderTopRightRadius: radius.container,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    maxHeight: '92%',
    overflow: 'hidden',
    paddingTop: spacing.md,
  },
  title: {
    color: colors.textPrimary,
    fontSize: typeScale.subtitle,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.listTitle,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
});
