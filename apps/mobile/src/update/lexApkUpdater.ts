import AsyncStorage from '@react-native-async-storage/async-storage';
import { IS_LEX_MOBILE, LEX_PRODUCT } from '@/config/lexMobile';
import { APP_BINARY_VERSION } from '@/config/env';
import { lexApkNative } from './lexApkNative';
import {
  defaultLexUpdateChannel, parseLexApkManifest, LEX_APK_CHECK_INTERVAL,
  LEX_APK_REMINDER_INTERVAL, type LexApkManifest, type LexUpdateChannel,
} from './lexApkModel';

export type LexApkPhase = 'idle' | 'checking' | 'available' | 'current' | 'unpublished'
  | 'downloading' | 'downloaded' | 'installing' | 'permission-required' | 'installer-opened' | 'error';
export interface LexApkState {
  ready: boolean; channel: LexUpdateChannel; phase: LexApkPhase;
  target: LexApkManifest | null; progress: number; error: string | null;
}
const CHANNEL_KEY = 'lex.mobile.apk.channel.v1';
const CHECK_KEY = 'lex.mobile.apk.last-check.v1';
const REMINDER_KEY = 'lex.mobile.apk.reminder.v1';
let state: LexApkState = { ready: false, channel: defaultLexUpdateChannel(APP_BINARY_VERSION), phase: 'idle', target: null, progress: 0, error: null };
const listeners = new Set<() => void>();
let hydration: Promise<void> | null = null;
let generation = 0;
let checkFlight: Promise<void> | null = null;
let downloadFlight: Promise<void> | null = null;
let installFlight: Promise<void> | null = null;
let controller: AbortController | null = null;
let preferenceQueue: Promise<void> = Promise.resolve();
let lastCheck = 0;
let reminderBusy = false;
export const lexApkAvailable = IS_LEX_MOBILE && lexApkNative !== null;
export const getLexApkState = () => state;
export function subscribeLexApk(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
function publish(next: Partial<LexApkState>) {
  state = { ...state, ...next }; listeners.forEach(listener => listener());
}
function fail(error: unknown) {
  // Native errors may contain platform details; only localized categories reach UI.
  const message = error instanceof Error ? error.message : String(error);
  const code = ['SIGNATURE_MISMATCH', 'CHECKSUM_MISMATCH', 'SIZE_MISMATCH', 'WRONG_PACKAGE', 'WRONG_VERSION', 'STORAGE_UNAVAILABLE', 'INVALID_METADATA'].find(value => message.includes(value)) ?? 'NETWORK_OR_INSTALL_FAILED';
  publish({ phase: 'error', error: code });
}
export function hydrateLexApk(): Promise<void> {
  if (hydration) return hydration;
  hydration = (async () => {
    const saved = await AsyncStorage.getItem(CHANNEL_KEY);
    let channel = defaultLexUpdateChannel(APP_BINARY_VERSION);
    if (saved === 'release' || saved === 'beta') channel = saved;
    else if (saved === null) {
      // Only explicit upstream user choices migrate, never an organization default.
      const legacy = await AsyncStorage.getItem('cindy.mobile.update.beta.meta.v1');
      if (legacy) {
        let record: { userOverride?: unknown } = {};
        try { record = JSON.parse(legacy) ?? {}; } catch { /* Ignore corrupt legacy preference. */ }
        if (typeof record.userOverride === 'boolean') {
          channel = record.userOverride ? 'beta' : 'release';
          await AsyncStorage.setItem(CHANNEL_KEY, channel);
        }
      } else if (await AsyncStorage.getItem('cindy.mobile.update.beta') === 'true') {
        channel = 'beta'; await AsyncStorage.setItem(CHANNEL_KEY, channel);
      }
    }
    const timestamp = Number(await AsyncStorage.getItem(CHECK_KEY));
    lastCheck = Number.isFinite(timestamp) && timestamp <= Date.now() ? timestamp : 0;
    publish({ ready: true, channel });
  })().catch(error => { hydration = null; fail(error); throw error; });
  return hydration;
}
export async function setLexApkChannel(channel: LexUpdateChannel): Promise<void> {
  if (channel !== 'release' && channel !== 'beta') return;
  await hydrateLexApk();
  if (installFlight) return;
  const current = ++generation;
  controller?.abort(); checkFlight = null; lexApkNative?.cancel();
  publish({ ready: false, phase: 'idle', target: null, error: null, progress: 0 });
  const write = preferenceQueue.catch(() => undefined).then(() => AsyncStorage.setItem(CHANNEL_KEY, channel));
  preferenceQueue = write;
  try {
    await write;
    if (current === generation) { lastCheck = 0; publish({ ready: true, channel }); }
  } catch (error) {
    if (current === generation) { publish({ ready: true }); fail(error); }
  }
}

export async function checkLexApk(manual = true): Promise<void> {
  if (!lexApkAvailable || !lexApkNative) return;
  await hydrateLexApk();
  if (!state.ready || downloadFlight || installFlight) return;
  if (checkFlight) return checkFlight;
  if (!manual && (Date.now() - lastCheck < LEX_APK_CHECK_INTERVAL
    || ['downloaded', 'permission-required', 'installer-opened'].includes(state.phase))) return;
  const current = generation;
  const previous = state;
  const channel = state.channel;
  const abort = new AbortController(); controller = abort;
  const timer = setTimeout(() => abort.abort(), 10000);
  publish({ phase: 'checking', error: null });
  lastCheck = Date.now();
  const run = (async () => {
    try {
      void AsyncStorage.setItem(CHECK_KEY, String(lastCheck)).catch(() => undefined);
      const url = LEX_PRODUCT.updateManifestBaseUrl + '/manifest-android' + (channel === 'beta' ? '-beta' : '') + '.json?t=' + Date.now();
      const response = await fetch(url, { signal: abort.signal, headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } });
      if (current !== generation) return;
      if (response.status === 404) { publish({ phase: 'unpublished', target: null }); return; }
      if (!response.ok) throw new Error('NETWORK_OR_INSTALL_FAILED');
      const body = await response.text();
      if (body.length > 256 * 1024) throw new Error('INVALID_METADATA');
      const target = parseLexApkManifest(JSON.parse(body), channel);
      const installed = await lexApkNative.installed();
      if (current !== generation) return;
      publish(target.versionCode > installed.versionCode
        ? { phase: previous.target?.sha256 === target.sha256 && ['downloaded', 'permission-required', 'installer-opened'].includes(previous.phase) ? previous.phase : 'available', target }
        : { phase: 'current', target: null });
    } catch (error) { if (current === generation) fail(error); }
    finally { clearTimeout(timer); if (controller === abort) controller = null; }
  })();
  checkFlight = run;
  try { await run; } finally { if (checkFlight === run) checkFlight = null; }
}

export async function downloadLexApk(): Promise<void> {
  if (!lexApkNative || !state.target || !state.ready || installFlight) return;
  if (downloadFlight) return downloadFlight;
  if (state.phase !== 'available' && state.phase !== 'error') return;
  const current = generation;
  const target = state.target;
  publish({ phase: 'downloading', progress: 0, error: null });
  const subscription = lexApkNative.addListener('progress', event => {
    if (current === generation && event.sha256 === target.sha256) publish({ progress: Math.min(1, event.received / target.size) });
  });
  const run = (async () => {
    try {
      await lexApkNative.download(target);
      if (current === generation) publish({ phase: 'downloaded', progress: 1 });
    } catch (error) { if (current === generation) fail(error); }
    finally { subscription.remove(); }
  })();
  downloadFlight = run;
  try { await run; } finally { if (downloadFlight === run) downloadFlight = null; }
}
export function cancelLexApk(): void {
  if (installFlight) return;
  generation++; controller?.abort(); checkFlight = null; lexApkNative?.cancel();
  publish({ phase: state.target ? 'available' : 'idle', error: null, progress: 0 });
}
export async function installLexApk(): Promise<void> {
  if (!lexApkNative || !state.target || !state.ready || downloadFlight) return;
  if (installFlight) return installFlight;
  if (!['downloaded', 'permission-required', 'installer-opened'].includes(state.phase)) return;
  const current = generation;
  const target = state.target;
  publish({ phase: 'installing', error: null });
  const run = (async () => {
    try {
      const phase = await lexApkNative.install(target);
      if (current === generation) publish({ phase });
    } catch (error) { if (current === generation) fail(error); }
  })();
  installFlight = run;
  try { await run; } finally { if (installFlight === run) installFlight = null; }
}
export async function openLexInstallPermission(): Promise<void> {
  try { await lexApkNative?.openPermissionSettings(); } catch (error) { fail(error); }
}
export async function claimLexApkReminder(): Promise<LexApkManifest | null> {
  const target = state.target;
  const current = generation;
  if (reminderBusy || state.phase !== 'available' || !target) return null;
  reminderBusy = true;
  try {
    const raw = await AsyncStorage.getItem(REMINDER_KEY);
    const previous = raw ? JSON.parse(raw) as { sha256: string; at: number } : null;
    if (previous?.sha256 === target.sha256 && Date.now() - previous.at < LEX_APK_REMINDER_INTERVAL) return null;
    if (current !== generation || state.target !== target || state.phase !== 'available') return null;
    await AsyncStorage.setItem(REMINDER_KEY, JSON.stringify({ sha256: target.sha256, at: Date.now() }));
    return current === generation && state.target === target && state.phase === 'available' ? target : null;
  } catch { return null; }
  finally { reminderBusy = false; }
}

export async function refreshLexApkPermission(): Promise<void> {
  if (!lexApkNative || state.phase !== 'permission-required') return;
  const current = generation;
  try {
    const allowed = await lexApkNative.canInstall();
    if (allowed && current === generation && state.phase === 'permission-required') publish({ phase: 'downloaded' });
  } catch { /* Keep the explicit retry controls available. */ }
}
