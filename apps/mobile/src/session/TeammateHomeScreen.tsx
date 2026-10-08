import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Alert, Keyboard, StyleSheet, View } from 'react-native';
import { Stack, useIsFocused, useRouter } from 'expo-router';
import { Menu } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { Text } from '@/components/AppText';
import { formatRemoteError } from '@/device-link/remoteStatus';
import { useGuardedPush } from '@/utils/useGuardedPush';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, iconStroke, spacing, typeScale } from '@/theme/tokens';
import { AccountSwitcherSheet } from './AccountSwitcherSheet';
import { HomeChromeDrawer } from './HomeChromeDrawer';
import { HomeHeaderGlassButton } from './HomeHeaderGlassButton';
import { TeammateCreateButton } from './TeammateCreateButton';
import { TeammateList } from './TeammateList';
import { useTeammateRoster } from './useTeammateRoster';
import { useTeammateNavigation } from './useTeammateNavigation';
import { remoteSessionStore } from './remoteSessionStore';

/** Launch, Back and refresh stay on the roster; opening a chat requires an explicit selection. */
export function TeammateHomeScreen({ active = true }: { active?: boolean }) {
  const { t } = useTranslation();
  const auth = useAuth();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const routeFocused = useIsFocused();
  const focused = routeFocused && active;
  const push = useGuardedPush();
  const router = useRouter();
  const navigation = useTeammateNavigation();
  const roster = useTeammateRoster(focused);
  const [drawer, setDrawer] = useState(false);
  const [accounts, setAccounts] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [searchEpoch, setSearchEpoch] = useState(0);
  const pending = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  const currentAccount = useRef(auth.accountGeneration); currentAccount.current = auth.accountGeneration;
  const hasRunningTasks = useSyncExternalStore(
    // 账号切换与抽屉里的退出确认都要知道是否有运行中任务;两者都关着时不订阅。
    useCallback((listener) => accounts || drawer ? remoteSessionStore.subscribe(listener) : () => {}, [accounts, drawer]),
    useCallback(() => (accounts || drawer) && remoteSessionStore.getSessions().some((session) => remoteSessionStore.isSessionRunning(session.id)), [accounts, drawer]),
  );
  const afterDrawer = (action: () => void) => { pending.current = action; setDrawer(false); };
  const finishOverlay = () => { const action = pending.current; pending.current = null; action?.(); };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pending.current = null; };
  }, []);
  return <SafeAreaView style={styles.screen} testID="teammates.home">
    {active ? <Stack.Screen options={{ headerShown: false }} /> : null}
    <View style={styles.header}>
      <HomeHeaderGlassButton accessibilityLabel={t('devices.companions.openNavigation')} testID="teammates.navigation"
        onPress={() => { Keyboard.dismiss(); setDrawer(true); }}>
        <Menu color={colors.textPrimary} size={iconSize.xl} strokeWidth={iconStroke.regular} />
      </HomeHeaderGlassButton>
      <Text style={styles.title}>{t('devices.companions.title')}</Text>
      <View style={styles.trailing}>
        {roster.createTargets.length > 0 ? <TeammateCreateButton targets={roster.createTargets} preferredDeviceId={navigation.lastTeammate?.deviceId}
          onInteract={() => { }} onCreated={(host, ref) => { void navigation.openCreatedTeammate(host, ref); }} /> : null}
      </View>
    </View>
    {roster.loading ? <ActivityIndicator color={colors.textSecondary} /> : null}
    {navigation.saveFailed ? <Text accessibilityRole="alert" style={styles.notice}>{t('devices.companions.preferenceSaveFailed')}</Text> : null}
    <TeammateList key={searchEpoch} {...roster} current={navigation.lastTeammate} autoFocusSearch={searchEpoch > 0}
      onInteract={() => { }}
      onRefresh={() => { void roster.refresh(); }}
      onSelect={(item) => { void navigation.openTeammate(item); }} />
    <HomeChromeDrawer open={drawer} user={auth.user} loggingOut={loggingOut} hasRunningTasks={hasRunningTasks} mode="teammates"
      onModeChange={(mode) => afterDrawer(() => { void navigation.setMode(mode); })}
      onClose={() => { pending.current = null; setDrawer(false); }} onClosed={finishOverlay}
      onOpenSearch={() => afterDrawer(() => setSearchEpoch((epoch) => epoch + 1))}
      onOpenDevices={() => afterDrawer(() => push('/devices/manage'))}
      onOpenSettings={() => afterDrawer(() => push('/settings'))}
      onOpenAccounts={() => afterDrawer(() => setAccounts(true))}
      // 抽屉内部已 confirmLogout;成功后与设置页一致直接回登录页,不依赖外层自动跳转的时序。
      onLogout={() => {
        if (loggingOut) return;
        setLoggingOut(true);
        const account = auth.accountGeneration;
        void auth.logout().then(() => { router.replace('/login'); }, (cause) => {
          if (mounted.current && currentAccount.current === account) Alert.alert(t('devices.list.alert.actionFailed'), formatRemoteError(cause));
        }).finally(() => { if (mounted.current && currentAccount.current === account) setLoggingOut(false); });
      }} />
    <AccountSwitcherSheet visible={accounts} hasRunningTasks={hasRunningTasks} onClose={() => setAccounts(false)}
      onAddAccount={() => { pending.current = () => { void auth.beginAddAccount(); push('/add-account'); }; setAccounts(false); }}
      onClosed={finishOverlay} />
  </SafeAreaView>;
}
const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  screen: { backgroundColor: colors.surface, flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, minHeight: 48 },
  title: { flex: 1, color: colors.textPrimary, fontSize: typeScale.subtitle, fontWeight: fontWeight.medium, textAlign: 'center' },
  trailing: { width: 44, alignItems: 'center' },
  notice: { color: colors.textSecondary, fontSize: typeScale.footnote, padding: spacing.lg },
});
