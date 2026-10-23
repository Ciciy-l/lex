import { Alert } from 'react-native';
import type { TFunction } from 'i18next';

/**
 * Every sign-out entry (settings, home drawer, partner home and drawer) asks
 * first: signing out removes the current saved account and its local mirror,
 * keeping other accounts; that account's tasks stop reporting here. Switching accounts already warns; the
 * heavier action must not be quieter.
 */
export function confirmLogout(t: TFunction, hasRunningTasks: boolean, onConfirm: () => void): void {
  Alert.alert(
    t('settings.account.logoutConfirmTitle'),
    hasRunningTasks ? t('settings.account.logoutConfirmRunning') : t('settings.account.logoutHint'),
    [
      { text: t('devices.common.cancel'), style: 'cancel' },
      { text: t('settings.account.logout'), style: 'destructive', onPress: onConfirm },
    ],
  );
}
