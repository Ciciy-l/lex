import { useRouter, Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { useThemedStyles, type ThemeColors, spacing, typeScale, lineHeight, fontWeight } from '@/theme';

/** Guest is a real empty app state; remote content still requires an account. */
export function GuestHome() {
  const { t } = useTranslation(); const router = useRouter(); const styles = useThemedStyles(makeStyles);
  return <SafeAreaView style={styles.root} testID="guest.home">
    <Stack.Screen options={{ headerShown: false }} />
    <View style={styles.header}><Text style={styles.brand}>Lex</Text>
      <MainWindowActionButton action={{ label: t('settings.title'), onPress: () => router.push('/settings'), testID: 'guest.settings' }} />
    </View>
    <View style={styles.content}><Text style={styles.title}>{t('serviceLogin.guestTitle')}</Text>
      <Text style={styles.hint}>{t('serviceLogin.guestHint')}</Text>
      <MainWindowActionButton action={{ label: t('serviceLogin.login'), tone: 'primary', onPress: () => router.push('/login'), testID: 'guest.login' }} />
    </View>
  </SafeAreaView>;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing.lg },
  brand: { fontSize: typeScale.title, color: colors.textPrimary, fontWeight: fontWeight.medium },
  content: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xl, gap: spacing.lg },
  title: { fontSize: typeScale.title, lineHeight: lineHeight.title, fontWeight: fontWeight.medium, color: colors.textPrimary, textAlign: 'center' },
  hint: { fontSize: typeScale.body, lineHeight: lineHeight.body, color: colors.textSecondary, textAlign: 'center' },
});
