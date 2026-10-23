import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BackHandler, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { isValidEmail } from '@cindy/auth-client';
import { useAuth } from './AuthContext';
import { supportsLexServiceWebSocket } from '@/device-link/lexServiceWebSocket';
import { Text, TextInput } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { SimpleStackHeader } from '@/platform/chrome/SimpleStackHeader';
import { useTheme, useThemedStyles, type ThemeColors, spacing, radius, typeScale, lineHeight, fontWeight } from '@/theme';
import { authErrorText, loginText } from './loginMessages';

/** Presentation only: pending destination and every login commit are owned by AuthContext. */
export function MobileServiceLogin({ renderCindy, onClose }: { renderCindy(back: () => void): ReactNode; onClose?: () => void }) {
  const auth = useAuth(), router = useRouter(), { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const [screen, setScreen] = useState<'services' | 'address' | 'lex' | 'cindy'>(auth.pendingService?.kind === 'cindy' ? 'cindy' : 'services');
  const [origin, setOrigin] = useState(''), [email, setEmail] = useState(''), [code, setCode] = useState('');
  const [resendAt, setResendAt] = useState(0), [now, setNow] = useState(Date.now);
  const submitting = useRef(false);
  const mounted = useRef(true);
  const finished = useRef(false);
  const cancel = async () => {
    if (screen === 'lex' && auth.loginState && auth.loginState.step !== 'identifier') {
      await auth.dispatchLoginAction({ type: 'back' }); setCode(''); return;
    }
    try { await auth.cancelLoginService(); } catch { return; }
    if (!mounted.current) return;
    if (screen === 'services') { if (onClose) onClose(); else router.replace('/'); }
    else { setScreen('services'); setCode(''); }
  };
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { void cancel(); return true; });
    return () => subscription.remove();
  });
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (!finished.current) void auth.cancelLoginService().catch(() => undefined); };
  }, [auth.cancelLoginService]);
  useEffect(() => { if (auth.pendingService?.kind === 'cindy') setScreen('cindy'); }, [auth.pendingService]);
  useEffect(() => {
    if (resendAt <= Date.now()) return;
    const timer = setTimeout(() => setNow(Date.now()), 1000);
    return () => clearTimeout(timer);
  }, [resendAt, now]);
  if (auth.loginState?.step === 'completed') finished.current = true;
  const run = async (operation: () => Promise<void>) => {
    if (submitting.current) return; submitting.current = true;
    try { await operation(); } finally { submitting.current = false; }
  };
  if (screen === 'cindy') return renderCindy(() => { void cancel(); });
  const state = auth.loginState;
  const sendCode = async () => {
    if (await auth.dispatchLoginAction({ type: 'request-code', kind: 'email', identifier: email })) {
      setCode(''); setNow(Date.now()); setResendAt(Date.now() + 60_000);
    }
  };
  const action = (label: string, onPress: () => void, testID: string, disabled = false) => <MainWindowActionButton
    action={{ label, onPress, testID, disabled, busy: auth.isBusy, tone: 'primary' }} />;
  return <SafeAreaView style={styles.root} testID="login.service.screen">
    <Stack.Screen options={{ headerShown: false }} />
    <SimpleStackHeader title={screen === 'services' ? t('serviceLogin.chooseService') : 'Lex Server'} onBack={() => { void cancel(); }} />
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.form}>
          <Text style={styles.title}>{t(screen === 'services' ? 'serviceLogin.chooseService' : screen === 'address' ? 'serviceLogin.serverAddress' : 'serviceLogin.emailLogin')}</Text>
          {screen === 'services' ? <>
            {Platform.OS === 'android' ? action('Lex Server', () => { auth.clearAuthError(); setScreen('address'); }, 'login.service.lex', !supportsLexServiceWebSocket()) : null}
            {Platform.OS === 'android' && !supportsLexServiceWebSocket() ? <Text style={styles.hint}>{t('serviceLogin.nativeUpdateRequired')}</Text> : null}
            {action('Cindy', () => { void run(async () => { if (await auth.selectLoginService({ kind: 'cindy', realm: auth.loginRealm }) && mounted.current) setScreen('cindy'); }); }, 'login.service.cindy')}
          </> : screen === 'address' ? <>
            <Text style={styles.hint}>{t('serviceLogin.serverHint')}</Text>
            <TextInput style={styles.input} value={origin} onChangeText={value => { setOrigin(value); auth.clearAuthError(); }}
              autoCapitalize="none" autoCorrect={false} keyboardType="url" accessibilityLabel={t('serviceLogin.serverAddress')}
              placeholder="https://server.example.com" placeholderTextColor={colors.textPlaceholder} testID="login.server.address" editable={!auth.isBusy} />
            {action(t('serviceLogin.continue'), () => { void run(async () => {
              if (await auth.selectLoginService({ kind: 'lex-server', origin }) && mounted.current) setScreen('lex');
            }); }, 'login.server.continue', !origin.trim())}
          </> : <>
            <Text style={styles.hint} testID="login.server.host">{auth.pendingService?.kind === 'lex-server' ? new URL(auth.pendingService.origin).host : ''}</Text>
            {state?.step === 'account-selection' ? state.accounts.map(account => <MainWindowActionButton key={account.id} action={{
              label: [account.orgName, account.displayName].filter(Boolean).join(' · '), busy: auth.isBusy,
              testID: `login.account.${account.id}`, onPress: () => { void auth.dispatchLoginAction({ type: 'select-account', accountId: account.id }); },
            }} />) : state?.step === 'verification-code' ? <>
              <Text style={styles.hint}>{email}</Text>
              <TextInput style={styles.input} value={code} onChangeText={setCode} keyboardType="number-pad" autoComplete="one-time-code"
                accessibilityLabel={t('serviceLogin.code')} testID="login.server.code" editable={!auth.isBusy} />
              {action(t('serviceLogin.login'), () => { void auth.dispatchLoginAction({ type: 'verify-code', kind: 'email', identifier: email, code }); }, 'login.server.verify', !code.trim())}
              {action(resendAt > now ? loginText('resendCountdown').replace('{n}', String(Math.ceil((resendAt - now) / 1000))) : loginText('resendCode'),
                () => { void sendCode(); }, 'login.server.resend', resendAt > now)}
            </> : <>
              <TextInput style={styles.input} value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address"
                autoComplete="email" accessibilityLabel={t('serviceLogin.email')} placeholder={t('serviceLogin.email')} placeholderTextColor={colors.textPlaceholder}
                testID="login.server.email" editable={!auth.isBusy} />
              {action(t('serviceLogin.sendCode'), () => { void sendCode(); }, 'login.server.sendCode', !isValidEmail(email))}
            </>}
          </>}
          {auth.authError ? <Text accessibilityRole="alert" style={styles.error} testID="login.service.error">{['INVALID_SERVER_URL', 'SERVER_HTTPS_REQUIRED', 'SERVER_UNAVAILABLE', 'INVALID_SERVER_RESPONSE', 'UNSUPPORTED_SERVER_AUTH', 'LEX_SERVER_NATIVE_UPDATE_REQUIRED'].includes(auth.authError)
            ? t('serviceLogin.serverError') : authErrorText(auth.authError)}</Text> : null}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface }, flex: { flex: 1 },
  content: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl },
  form: { width: '100%', maxWidth: 480, alignSelf: 'center', gap: spacing.lg },
  title: { color: colors.textPrimary, fontSize: typeScale.title, lineHeight: lineHeight.title, fontWeight: fontWeight.medium },
  hint: { color: colors.textSecondary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall },
  input: { color: colors.textPrimary, backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderWidth: 1,
    borderRadius: radius.pill, minHeight: 48, paddingHorizontal: spacing.lg, fontSize: typeScale.body },
  error: { color: colors.statusError, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall },
});
