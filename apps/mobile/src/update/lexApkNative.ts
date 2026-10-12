import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';
import { Platform } from 'react-native';
import type { LexApkManifest } from './lexApkModel';

export interface LexApkNative {
  installed(): Promise<{ version: string; versionCode: number; packageName: string }>;
  download(target: LexApkManifest): Promise<boolean>;
  cancel(): void;
  install(target: LexApkManifest): Promise<'permission-required' | 'installer-opened'>;
  canInstall(): Promise<boolean>;
  openPermissionSettings(): Promise<void>;
  addListener(event: 'progress', listener: (progress: { sha256: string; received: number; total: number }) => void): EventSubscription;
}
export const lexApkNative = Platform.OS === 'android'
  ? requireOptionalNativeModule<LexApkNative>('LexApkUpdater') : null;
