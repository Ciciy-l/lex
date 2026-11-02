import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Application from 'expo-application';
import { fetch as expoFetch } from 'expo/fetch';
import { Linking, Platform } from 'react-native';
import { IS_LEX_MOBILE, LEX_PRODUCT } from '@/config/lexMobile';
import { defaultLexUpdateChannel, LEX_APK_CHECK_INTERVAL, LEX_APK_REMINDER_INTERVAL, type LexUpdateChannel } from './lexApkModel';
import { compareNumericVersion, isNewerIosRelease, parseLexIosManifest, type LexIosManifest } from './lexIosModel';

export const lexIosAvailable = IS_LEX_MOBILE && Platform.OS === 'ios';
// A re-signing tool may replace the bundle ID. Do not use that ID as the product
// gate. Native version/build remain the installed identity, Expo supplies RC text.
const nativeVersion = Application.nativeApplicationVersion;
const expoVersion = Constants.expoConfig?.version ?? '';
export const lexIosInstalledVersion = !nativeVersion || expoVersion.split('-')[0] === nativeVersion ? expoVersion : nativeVersion;
export const lexIosInstalledBuild = Application.nativeBuildVersion ?? Constants.expoConfig?.ios?.buildNumber ?? '';
export type LexIosPhase = 'idle' | 'checking' | 'current' | 'available' | 'unpublished' | 'incompatible' | 'ignored' | 'error';
interface State { ready: boolean; phase: LexIosPhase; channel: LexUpdateChannel; target: LexIosManifest | null; error: string | null }
const KEY = 'lex.mobile.ios.update.v1';
let state: State = { ready: false, phase: 'idle', channel: defaultLexUpdateChannel(lexIosInstalledVersion), target: null, error: null };
const listeners = new Set<() => void>();
let hydration: Promise<void> | null = null;
let flight: Promise<void> | null = null;
let flightManual = false;
let controller: AbortController | null = null;
let generation = 0;
let lastCheck = 0;
let ignored = '';
let reminder: { sha256: string; at: number } | null = null;
let queue: Promise<void> = Promise.resolve();
let claiming = false;
export const getLexIosState = () => state;
export const subscribeLexIos = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function publish(next: Partial<State>) { state = { ...state, ...next }; listeners.forEach(listener => listener()); }
function save(key: string, value: string): Promise<void> {
  const write = queue.catch(() => undefined).then(() => AsyncStorage.setItem(KEY + '.' + key, value));
  queue = write; return write;
}
export function hydrateLexIos(): Promise<void> {
  if (hydration) return hydration;
  hydration = (async () => {
    const [channel, check, ignore, reminded] = await Promise.all(['channel', 'check', 'ignored', 'reminder'].map(key => AsyncStorage.getItem(KEY + '.' + key)));
    lastCheck = Number(check) > 0 && Number(check) <= Date.now() ? Number(check) : 0;
    ignored = ignore ?? '';
    try { reminder = reminded ? JSON.parse(reminded) : null; } catch { reminder = null; }
    publish({ ready: true, channel: channel === 'release' || channel === 'beta' ? channel : defaultLexUpdateChannel(lexIosInstalledVersion) });
  })().catch(() => { hydration = null; publish({ phase: 'error', error: 'STORAGE_FAILED' }); });
  return hydration;
}
export async function setLexIosChannel(channel: LexUpdateChannel): Promise<boolean> {
  await hydrateLexIos();
  if (!lexIosAvailable || !state.ready || (channel !== 'release' && channel !== 'beta')) return false;
  if (state.channel === channel) return true;
  const current = ++generation; controller?.abort(); flight = null;
  publish({ ready: false, phase: 'idle', target: null, error: null });
  try {
    await save('check', '0');
    await save('channel', channel);
    if (generation === current) { lastCheck = 0; publish({ ready: true, channel }); }
    return generation === current;
  } catch { if (generation === current) publish({ ready: true, phase: 'error', error: 'STORAGE_FAILED' }); }
  return false;
}
export async function checkLexIos(manual = true): Promise<void> {
  if (!lexIosAvailable) return;
  await hydrateLexIos();
  if (!state.ready) return;
  if (flight) { flightManual ||= manual; return flight; }
  if (!manual && Date.now() - lastCheck < LEX_APK_CHECK_INTERVAL) return;
  const current = generation, channel = state.channel;
  flightManual = manual;
  const abort = new AbortController(); controller = abort;
  const timer = setTimeout(() => abort.abort(), 10_000);
  lastCheck = Date.now(); void save('check', String(lastCheck)).catch(() => undefined);
  publish({ phase: 'checking', target: null, error: null });
  const run = (async () => {
    try {
      const url = LEX_PRODUCT.updateManifestBaseUrl + '/manifest-ios' + (channel === 'beta' ? '-beta' : '') + '.json?t=' + lastCheck;
      // Expo fetch has no RequestInit.cache. A cache-busting URL and a standard
      // revalidation header work through its supported native request interface.
      const response = await expoFetch(url, { credentials: 'omit', redirect: 'error',
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' }, signal: abort.signal });
      if (current !== generation) return;
      if (response.status === 404) { publish({ phase: 'unpublished' }); return; }
      if (!response.ok) throw new Error('CHECK_FAILED');
      if (response.redirected || (response.url && response.url !== url)) throw new Error('INVALID_METADATA');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('INVALID_METADATA');
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 256 * 1024) throw new Error('INVALID_METADATA');
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let target: LexIosManifest;
      try { target = parseLexIosManifest(JSON.parse(new TextDecoder().decode(bytes)), channel); }
      catch { throw new Error('INVALID_METADATA'); }
      if (current !== generation) return;
      if (abort.signal.aborted) throw new Error('CHECK_FAILED');
      if (!isNewerIosRelease(target, lexIosInstalledVersion, lexIosInstalledBuild)) { publish({ phase: 'current' }); return; }
      const phase = compareNumericVersion(String(Platform.Version), target.minimumOSVersion) < 0 ? 'incompatible'
        : !flightManual && ignored === target.sha256 ? 'ignored' : 'available';
      publish({ phase, target });
    } catch (error) {
      if (current === generation) publish({ phase: 'error', target: null,
        error: error instanceof Error && error.message === 'INVALID_METADATA' ? 'INVALID_METADATA' : 'CHECK_FAILED' });
    } finally { clearTimeout(timer); if (controller === abort) controller = null; }
  })();
  flight = run; try { await run; } finally { if (flight === run) flight = null; }
}
export async function ignoreLexIos(target: LexIosManifest): Promise<void> {
  if (!lexIosAvailable || state.target !== target || !['available', 'ignored'].includes(state.phase)) return;
  const current = generation;
  try {
    await save('ignored', target.sha256); ignored = target.sha256;
    if (current === generation && state.target === target) publish({ phase: 'ignored', error: null });
  } catch { if (current === generation && state.target === target) publish({ error: 'STORAGE_FAILED' }); }
}
export async function claimLexIosReminder(): Promise<LexIosManifest | null> {
  const target = state.target, current = generation;
  if (claiming || state.phase !== 'available' || !target || ignored === target.sha256) return null;
  const elapsed = Date.now() - (reminder?.at ?? 0);
  if (reminder?.sha256 === target.sha256 && elapsed >= 0 && elapsed < LEX_APK_REMINDER_INTERVAL) return null;
  claiming = true;
  try {
    const next = { sha256: target.sha256, at: Date.now() };
    await save('reminder', JSON.stringify(next)); reminder = next;
    return current === generation && state.target === target && state.phase === 'available' ? target : null;
  } catch { return null; } finally { claiming = false; }
}
export async function downloadLexIos(target: LexIosManifest): Promise<void> {
  if (!lexIosAvailable || state.target !== target || !['available', 'ignored'].includes(state.phase)) return;
  const current = generation;
  try {
    parseLexIosManifest(target, state.channel); // Validate again at the external-navigation boundary.
    await Linking.openURL(target.file); // No auth headers, cookies or service parameters.
    if (current === generation && state.target === target) publish({ error: null });
  } catch { if (current === generation && state.target === target) publish({ error: 'LINK_FAILED' }); }
}
