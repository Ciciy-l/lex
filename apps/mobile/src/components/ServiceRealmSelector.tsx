import type { AuthRegion } from '@cindy/auth-client';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from './AppText';
import { loginText } from '@/auth/loginMessages';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

export function ServiceRealmSelector({ realm, disabled = false, onSelect }: {
  realm: AuthRegion; disabled?: boolean; onSelect: (realm: AuthRegion) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.root}>
    <Text style={styles.label}>{loginText('serviceRealm')}</Text>
    <View style={styles.choices}>
      {(['global', 'cn'] as const).map(value => <Pressable key={value}
        accessibilityRole="radio" accessibilityState={{ checked: realm === value, disabled }}
        disabled={disabled} testID={`login.realm.${value}`} onPress={() => onSelect(value)}
        style={[styles.choice, realm === value && styles.selected]}>
        <Text style={styles.text}>{loginText(value === 'cn' ? 'serviceRealmCn' : 'serviceRealmGlobal')}</Text>
      </Pressable>)}
    </View>
  </View>;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { gap: spacing.xs, alignItems: 'center' },
  label: { color: colors.textSecondary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall },
  choices: { flexDirection: 'row', gap: spacing.sm },
  choice: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.lg, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border },
  selected: { backgroundColor: colors.surfaceElevated },
  text: { color: colors.textPrimary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.medium },
});
