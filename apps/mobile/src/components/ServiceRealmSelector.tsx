import type { AuthRegion } from '@cindy/auth-client';
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Text } from './AppText';
import { loginText } from '@/auth/loginMessages';
import { useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

// Physical points: the login artwork scales, but these touch targets must not.
export const SERVICE_REALM_SELECTOR_HEIGHT = 44 + spacing.xs * 2;

export function ServiceRealmSelector({ realm, disabled = false, onSelect, onLayout }: {
  realm: AuthRegion; disabled?: boolean; onSelect: (realm: AuthRegion) => void;
  onLayout?: (event: LayoutChangeEvent) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.root} onLayout={onLayout} testID="login.realmSelector">
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
  root: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center', justifyContent: 'center',
    minHeight: SERVICE_REALM_SELECTOR_HEIGHT, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs,
    backgroundColor: colors.surface, borderRadius: radius.container },
  label: { flexGrow: 1, textAlign: 'center', color: colors.textSecondary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall },
  choices: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.sm },
  choice: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border },
  selected: { backgroundColor: colors.surfaceChip, borderColor: colors.borderStrong },
  text: { color: colors.textPrimary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.medium },
});
