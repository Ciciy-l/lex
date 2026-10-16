import { Redirect } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { resolveRemoteText, type RemoteResource, type RemoteSessionLinkTarget } from '@cindy/device-link';


import { startFocusedTopicSubscription } from '@/device-link/focusedTopicSubscription';
import { Text } from '@/components/AppText';
import { MainWindowActionButton, MainWindowEmptyState } from '@/components/MobilePrimitives';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { getRemoteResource, type RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { formatRemoteError } from '@/device-link/remoteStatus';
import { SimpleStackHeader, simpleScreenSafeAreaEdges } from '@/platform/chrome';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import type { RemoteSession } from '@/session/types';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { iconSize, spacing, typeScale } from '@/theme/tokens';
import { goBackGuarded } from '@/utils/backGuard';



function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function RemoteResourceResolverScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const { invoke, connectionEpoch, status, onRemoteResourceChanged, subscribe, unsubscribe } = useDeviceLink();
  const { accountGeneration } = useAuth();
  const binding = `${accountGeneration}:${connectionEpoch}`;
  const currentBinding = useRef(binding); currentBinding.current = binding;
  const params = useLocalSearchParams<{
    collectionId?: string;
    resourceId?: string;
    resourceKind?: string;
    deviceId?: string;
    deviceName?: string;
    title?: string;
  }>();
  const collectionId = firstParam(params.collectionId);
  const resourceId = firstParam(params.resourceId);
  const resourceKind = firstParam(params.resourceKind);
  const deviceId = firstParam(params.deviceId);
  const deviceName = firstParam(params.deviceName) || deviceId;
  const title = firstParam(params.title) || t('devices.resources.titleFallback');
  const host = useMemo<RemoteResourceHostTarget>(
    () => ({ deviceId, deviceName }),
    [deviceId, deviceName],
  );
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const resolveGenerationRef = useRef(0);

  const resolveConversation = useCallback(async () => {
    const generation = ++resolveGenerationRef.current;
    setError(null);
    if (!collectionId || !resourceId || !resourceKind || !deviceId) {
      setError(t('devices.resources.noHosts'));
      return;
    }
    try {
      // Resolve the opaque resource again on every open. A desktop module may
      // roll its canonical Session without invalidating the permanent route.
      const response = await getRemoteResource(invoke, host, {
        collectionId,
        id: resourceId,
        kind: resourceKind,
      }, i18n.language);
      if (resolveGenerationRef.current !== generation || currentBinding.current !== binding) return;
      const link = response.links.find((item) => item.rel === 'conversation');
      const target = link?.target as RemoteSessionLinkTarget | undefined;
      if (!target || target.kind !== 'session' || typeof target.sessionId !== 'string') {
        setError(t('devices.resources.noConversation'));
        return;
      }
      const session = await invoke<RemoteSession>(deviceId, 'local-db:sessions:get', [target.sessionId]);
      if (resolveGenerationRef.current !== generation || currentBinding.current !== binding) return;
      if (!session || session.id !== target.sessionId || session.source === 'bot') throw new Error(t('devices.resources.noConversation'));
      const existingOrigin = remoteSessionStore.getSessionDeviceId(session.id);
      if (existingOrigin && existingOrigin !== deviceId) throw new Error(t('devices.resources.noConversation'));
      remoteSessionStore.upsertDeviceSession(deviceId, deviceName, session);
      router.replace({
        pathname: '/sessions/[sessionId]',
        params: {
          deviceId,
          deviceName,
          sessionId: target.sessionId,
          resourceCollectionId: collectionId,
          resourceId,
          resourceKind,
        },
      });
    } catch (cause) {
      if (resolveGenerationRef.current === generation && currentBinding.current === binding) setError(formatRemoteError(cause));
    }
  }, [binding, collectionId, deviceId, deviceName, host, i18n.language, invoke, resourceId, resourceKind, router, t]);

  useFocusEffect(useCallback(() => {

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let loading = false;
    let refreshAgain = false;
    const load = async () => {
      if (disposed || AppState.currentState !== 'active') return;
      if (loading) { refreshAgain = true; return; }
      if (timer) clearTimeout(timer);
      loading = true;
      await resolveConversation();
      loading = false;
      if (disposed) return;
      if (refreshAgain) { refreshAgain = false; void load(); }
    };
    const offPush = onRemoteResourceChanged((source, payload) => {
      if (source === deviceId && payload.collectionId === collectionId) void load();
    });
    const offTopic = startFocusedTopicSubscription({ deviceId, owner: `resource-resolver:${resourceId}`, topic: 'sessions', subscribe, unsubscribe });
    const appState = AppState.addEventListener('change', state => {
      if (state === 'active') void load();
      else { resolveGenerationRef.current += 1; if (timer) clearTimeout(timer); }
    });
    void load();
    return () => { disposed = true; resolveGenerationRef.current += 1; if (timer) clearTimeout(timer); offPush(); offTopic(); appState.remove(); };
  }, [attempt, collectionId, deviceId, onRemoteResourceChanged, resolveConversation, resourceId, status, subscribe, unsubscribe]));


  return (
    <SafeAreaView edges={simpleScreenSafeAreaEdges()} style={styles.safeArea} testID="remoteResourceResolver.screen">
      <SimpleStackHeader
        backTestID="remoteResourceResolver.backButton"
        onBack={() => goBackGuarded(router)}
        subtitle={deviceName}
        title={title}
        titleTestID="remoteResourceResolver.title"
      />
      {error ? (
        <View style={styles.content}>
          <MainWindowEmptyState
            copy={error}
            testID="remoteResourceResolver.error"
            title={t('devices.resources.openFailed')}
          />
          <MainWindowActionButton
            action={{
              label: t('devices.resources.retry'),
              onPress: () => setAttempt((value) => value + 1),
              testID: 'remoteResourceResolver.retry',
            }}
          />
        </View>
      ) : ((
        <View style={styles.center}>
          <ActivityIndicator color={colors.textSecondary} />
          <Text style={styles.muted}>{t('devices.resources.resolving')}</Text>
        </View>
      ))}
    </SafeAreaView>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  safeArea: { backgroundColor: colors.surface, flex: 1 },
  center: { alignItems: 'center', flex: 1, gap: spacing.lg, justifyContent: 'center', padding: spacing.xl },
  content: { flex: 1, gap: spacing.lg, justifyContent: 'center', padding: spacing.xl },
  preparationTitle: { color: colors.textPrimary, fontSize: typeScale.title, textAlign: 'center' },
  muted: { textAlign: 'center', color: colors.textSecondary, fontSize: typeScale.footnote },
});

export default function ResourceRoute() {
  const params = useLocalSearchParams<{ collectionId?: string; resourceKind?: string }>();
  if (['bot', 'bot-group'].includes(firstParam(params.resourceKind)) || ['teammates', 'bot-groups', 'routines'].includes(firstParam(params.collectionId))) return <Redirect href="/devices" />;
  return <RemoteResourceResolverScreen />;
}
