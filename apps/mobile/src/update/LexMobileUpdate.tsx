import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, AppState, Linking } from 'react-native';
import { useTranslation } from 'react-i18next';
import { APP_BINARY_VERSION } from '@/config/env';
import { IS_LEX_MOBILE, LEX_PRODUCT } from '@/config/lexMobile';
import { getLoginLanguage } from '@/auth/loginMessages';
import { ActionInfoRow, InfoRow, SettingsGroup, SettingsSwitchRow } from '@/session/SettingsGroupRows';
import { lexApkNotes } from './lexApkModel';
import {
  cancelLexApk, checkLexApk, claimLexApkReminder, downloadLexApk, getLexApkState,
  hydrateLexApk, installLexApk, lexApkAvailable, openLexInstallPermission,
  setLexApkChannel, subscribeLexApk, refreshLexApkPermission,
} from './lexApkUpdater';

function useLexApk() {
  const state = useSyncExternalStore(subscribeLexApk, getLexApkState, getLexApkState);
  useEffect(() => { if (lexApkAvailable) void hydrateLexApk().catch(() => undefined); }, []);
  return state;
}

/** Reminders never block startup, download without a click, or assume installation succeeded. */
export function LexMobileUpdateBridge() {
  const { t } = useTranslation();
  const state = useLexApk();
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const announcedDownload = useRef<string | null>(null);
  const announcedPermission = useRef<string | null>(null);
  useEffect(() => {
    if (!lexApkAvailable) return;
    let alive = true;
    let busy = false;
    const check = async () => {
      if (busy || AppState.currentState !== 'active') return;
      busy = true;
      try {
        await checkLexApk(false);
        if (!alive || AppState.currentState !== 'active') return;
        const target = await claimLexApkReminder();
        if (!target || !alive || AppState.currentState !== 'active') return;
        Alert.alert(t('update.lex.availableTitle', { version: target.version }),
          t('update.lex.downloadSize', { size: Math.ceil(target.size / 1024 ** 2) }) + '\n\n' + lexApkNotes(target, getLoginLanguage()), [
            { text: t('update.later'), style: 'cancel' },
            { text: t('update.lex.download'), onPress: () => {
              if (getLexApkState().target === target) void downloadLexApk();
            } },
          ]);
      } catch { /* Quiet checks must never block login or working tasks. */ }
      finally { busy = false; }
    };
    const timer = setTimeout(() => { void check(); }, 5000);
    let wasBackground = false;
    const subscription = AppState.addEventListener('change', value => {
      setForeground(value === 'active');
      if (value === 'background') wasBackground = true;
      if (value === 'active' && wasBackground) { wasBackground = false; void refreshLexApkPermission(); void check(); }
    });
    return () => { alive = false; clearTimeout(timer); subscription.remove(); };
  }, [t]);
  useEffect(() => {
    const target = state.target;
    if (!foreground || state.phase !== 'downloaded' || !target || announcedDownload.current === target.sha256) return;
    announcedDownload.current = target.sha256;
    Alert.alert(t('update.lex.readyTitle'), t('update.lex.installHint'), [
      { text: t('update.later'), style: 'cancel' },
      { text: t('update.lex.install'), onPress: () => {
        if (getLexApkState().target === target) void installLexApk();
      } },
    ]);
  }, [foreground, state.phase, state.target, t]);
  useEffect(() => {
    if (state.phase !== 'permission-required') { announcedPermission.current = null; return; }
    if (!foreground || !state.target || announcedPermission.current === state.target.sha256) return;
    announcedPermission.current = state.target.sha256;
    announcedDownload.current = null;
    Alert.alert(t('update.lex.permissionTitle'), t('update.lex.permissionHint'), [
      { text: t('update.later'), style: 'cancel' },
      { text: t('update.lex.permissionAction'), onPress: () => { void openLexInstallPermission(); } },
    ]);
  }, [foreground, state.phase, state.target, t]);
  return null;
}

export function LexMobileInfoSection() {
  const { t } = useTranslation();
  const state = useLexApk();
  if (!IS_LEX_MOBILE) return null;
  const busy = !state.ready || ['checking', 'downloading', 'installing'].includes(state.phase);
  const installedAction = ['downloaded', 'permission-required', 'installer-opened'].includes(state.phase);
  const target = state.target;
  const open = (url: string) => { void Linking.openURL(url).catch(() => Alert.alert(t('update.lex.linkFailed'))); };
  return <>
    <SettingsGroup title={t('settings.version.sectionTitle')} footer={lexApkAvailable ? t('update.lex.installHint') : undefined}>
      <InfoRow label={t('update.lex.appVersion')} value={APP_BINARY_VERSION} />
      {lexApkAvailable ? [
        <SettingsSwitchRow key="channel" accessibilityLabel={t('update.lex.beta')} label={t('update.lex.beta')}
          value={state.channel === 'beta'} disabled={!state.ready || state.phase === 'installing'}
          hint={t('update.lex.betaHint')} onValueChange={value => { void setLexApkChannel(value ? 'beta' : 'release').then(() => checkLexApk()).catch(() => undefined); }} />,
        <ActionInfoRow key="check" accessibilityLabel={t('update.lex.check')} label={t('update.lex.check')}
          onPress={() => { void checkLexApk().catch(() => undefined); }} disabled={busy && state.ready}
          detail={state.error ? t('update.lex.errors.' + state.error) : t('update.lex.phases.' + state.phase)} />,
        target ? <InfoRow key="target" label={t('update.lex.availableTitle', { version: target.version })}
          value={t('update.lex.downloadSize', { size: Math.ceil(target.size / 1024 ** 2) })}
          detail={lexApkNotes(target, getLoginLanguage())} /> : null,
        state.phase === 'downloading' ? <ActionInfoRow key="cancel" accessibilityLabel={t('update.lex.cancelDownload')}
          label={t('update.lex.cancelDownload')} value={Math.round(state.progress * 100) + '%'} onPress={cancelLexApk} /> : null,
        target && !busy ? <ActionInfoRow key="download" accessibilityLabel={t(installedAction ? 'update.lex.install' : 'update.lex.download')}
          label={t(installedAction ? 'update.lex.install' : 'update.lex.download')}
          onPress={() => { void (installedAction ? installLexApk() : downloadLexApk()); }} /> : null,
        state.phase === 'permission-required' ? <ActionInfoRow key="permission" accessibilityLabel={t('update.lex.permissionAction')}
          label={t('update.lex.permissionAction')} detail={t('update.lex.permissionHint')} onPress={() => { void openLexInstallPermission(); }} /> : null,
      ] : <InfoRow label={t('update.lex.manual')} value="" detail={t('update.lex.manualHint')} />}
    </SettingsGroup>
    <SettingsGroup title={t('update.lex.about')} footer={t('update.lex.attribution')}>
      {(['homepageUrl', 'supportUrl', 'downloadPageUrl'] as const).map(key => <ActionInfoRow key={key}
        accessibilityRole="link" accessibilityLabel={t('update.lex.' + key)} label={t('update.lex.' + key)}
        onPress={() => open(LEX_PRODUCT[key])} />)}
      {target ? <ActionInfoRow accessibilityRole="link" accessibilityLabel={t('update.lex.releaseNotes')}
        label={t('update.lex.releaseNotes')} onPress={() => open(target.releaseUrl)} /> : null}
    </SettingsGroup>
  </>;
}
