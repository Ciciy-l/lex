import { useEffect, useSyncExternalStore } from 'react';
import { Alert, AppState, Linking } from 'react-native';
import { useTranslation } from 'react-i18next';
import { getLoginLanguage } from '@/auth/loginMessages';
import { ActionInfoRow, InfoRow, SettingsGroup, SettingsSwitchRow } from '@/session/SettingsGroupRows';
import { lexApkNotes } from './lexApkModel';
import { LEX_IOS_INSTALL_HELP } from './lexIosModel';
import { checkLexIos, claimLexIosReminder, downloadLexIos, getLexIosState, hydrateLexIos, ignoreLexIos,
  lexIosAvailable, lexIosInstalledVersion, lexIosInstalledBuild, setLexIosChannel, subscribeLexIos } from './lexIosUpdater';

function useLexIos() {
  const state = useSyncExternalStore(subscribeLexIos, getLexIosState, getLexIosState);
  useEffect(() => { if (lexIosAvailable) void hydrateLexIos(); }, []);
  return state;
}
export function LexIosUpdateBridge() {
  const { t } = useTranslation();
  useEffect(() => {
    if (!lexIosAvailable) return;
    let alive = true, busy = false, wasBackground = false;
    const check = async () => {
      if (busy || AppState.currentState !== 'active') return;
      busy = true;
      try {
        await checkLexIos(false);
        if (!alive || AppState.currentState !== 'active') return;
        const target = await claimLexIosReminder();
        if (!target || !alive || AppState.currentState !== 'active') return;
        Alert.alert(t('update.lex.availableTitle', { version: target.version }), t('update.lex.ios.installHint'), [
          { text: t('update.later'), style: 'cancel' },
          { text: t('update.lex.ios.ignore'), onPress: () => { void ignoreLexIos(target); } },
          { text: t('update.lex.ios.help'), onPress: () => {
            void Linking.openURL(LEX_IOS_INSTALL_HELP).catch(() => Alert.alert(t('update.lex.linkFailed')));
          } },
          { text: t('update.lex.ios.download'), onPress: () => { void downloadLexIos(target); } },
        ]);
      } catch { /* Automatic checks must not interrupt startup or work. */ }
      finally { busy = false; }
    };
    const timer = setTimeout(() => { void check(); }, 5000);
    const subscription = AppState.addEventListener('change', value => {
      if (value === 'background') wasBackground = true;
      if (value === 'active' && wasBackground) { wasBackground = false; void check(); }
    });
    return () => { alive = false; clearTimeout(timer); subscription.remove(); };
  }, [t]);
  return null;
}
export function LexIosVersionSection() {
  const { t } = useTranslation();
  const state = useLexIos();
  const target = state.target;
  const open = (url: string) => { void Linking.openURL(url).catch(() => Alert.alert(t('update.lex.linkFailed'))); };
  return <SettingsGroup title={t('settings.version.sectionTitle')} footer={t('update.lex.ios.installHint')}>
    <InfoRow label={t('update.lex.appVersion')} value={lexIosInstalledVersion} detail={t('update.lex.ios.build', { build: lexIosInstalledBuild })} />
    <SettingsSwitchRow accessibilityLabel={t('update.lex.beta')} label={t('update.lex.beta')}
      value={state.channel === 'beta'} disabled={!state.ready} hint={t('update.lex.betaHint')}
      onValueChange={value => { void setLexIosChannel(value ? 'beta' : 'release').then(async saved => { if (saved) await checkLexIos(); }); }} />
    <ActionInfoRow accessibilityLabel={t('update.lex.check')} label={t('update.lex.check')}
      disabled={state.phase === 'checking'} onPress={() => { void checkLexIos(); }}
      detail={state.error ? t('update.lex.ios.errors.' + state.error)
        : state.phase === 'incompatible' ? t('update.lex.ios.incompatible', { version: target?.minimumOSVersion })
        : state.phase === 'ignored' ? t('update.lex.ios.ignored')
        : state.phase === 'unpublished' ? t('update.lex.ios.unpublished') : t('update.lex.phases.' + state.phase)} />
    {target ? <InfoRow label={t('update.lex.availableTitle', { version: target.version })}
      value={t('update.lex.downloadSize', { size: Math.ceil(target.size / 1024 ** 2) })}
      detail={lexApkNotes(target, getLoginLanguage())} /> : null}
    {target && ['available', 'ignored'].includes(state.phase) ? <ActionInfoRow accessibilityRole="link"
      accessibilityLabel={t('update.lex.ios.download')} label={t('update.lex.ios.download')}
      onPress={() => { void downloadLexIos(target); }} /> : null}
    <ActionInfoRow accessibilityRole="link" accessibilityLabel={t('update.lex.ios.help')}
      label={t('update.lex.ios.help')} onPress={() => open(LEX_IOS_INSTALL_HELP)} />
    {target ? <ActionInfoRow accessibilityRole="link" accessibilityLabel={t('update.lex.releaseNotes')}
      label={t('update.lex.releaseNotes')} onPress={() => open(target.releaseUrl)} /> : null}
    {target && state.phase === 'available' ? <ActionInfoRow accessibilityLabel={t('update.lex.ios.ignore')}
      label={t('update.lex.ios.ignore')} onPress={() => { void ignoreLexIos(target); }} /> : null}
  </SettingsGroup>;
}
