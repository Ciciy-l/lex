import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { manifestFixture } from './lexApkTestFixture';
import { LEX_APK_CHECK_INTERVAL, LEX_APK_REMINDER_INTERVAL } from './lexApkModel';

const mocks = vi.hoisted(() => ({
  storage: new Map<string, string>(), get: vi.fn(), set: vi.fn(),
  native: { installed: vi.fn(), download: vi.fn(), cancel: vi.fn(), install: vi.fn(),
    canInstall: vi.fn(), openPermissionSettings: vi.fn(), addListener: vi.fn() },
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: mocks.get, setItem: mocks.set } }));
vi.mock('@/config/env', () => ({ APP_BINARY_VERSION: '0.1.4-rc.2' }));
vi.mock('@/config/lexMobile', () => ({ IS_LEX_MOBILE: true, LEX_PRODUCT: { updateManifestBaseUrl: 'https://raw.githubusercontent.com/Ciciy-l/lex/updates' } }));
vi.mock('./lexApkNative', () => ({ lexApkNative: mocks.native }));
const fetchMock = vi.fn();
let now = 1_800_000_000_000;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function setupAvailable() {
  const updater = await import('./lexApkUpdater');
  await updater.checkLexApk();
  expect(updater.getLexApkState().phase).toBe('available');
  return updater;
}
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks(); mocks.storage.clear();
  mocks.get.mockImplementation(async (key: string) => mocks.storage.get(key) ?? null);
  mocks.set.mockImplementation(async (key: string, value: string) => { mocks.storage.set(key, value); });
  mocks.native.installed.mockResolvedValue({ version: '0.1.4-rc.2', versionCode: 1000462, packageName: 'io.github.ciciyl.lex' });
  mocks.native.download.mockResolvedValue(true);
  mocks.native.install.mockResolvedValue('installer-opened');
  mocks.native.addListener.mockReturnValue({ remove: vi.fn() });
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(manifestFixture())));
  vi.stubGlobal('fetch', fetchMock);
  now = 1_800_000_000_000; vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Lex APK update lifecycle', () => {
  it('only checks automatically, enforces six hours and throttles the same reminder for 24 hours', async () => {
    const updater = await setupAvailable();
    expect(mocks.native.download).not.toHaveBeenCalled();
    await updater.checkLexApk(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const reminders = await Promise.all([updater.claimLexApkReminder(), updater.claimLexApkReminder()]);
    expect(reminders.filter(Boolean)).toHaveLength(1);
    now += LEX_APK_CHECK_INTERVAL;
    await updater.checkLexApk(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await updater.claimLexApkReminder()).toBeNull();
    now += LEX_APK_REMINDER_INTERVAL;
    expect(await updater.claimLexApkReminder()).not.toBeNull();
    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers.Authorization).toBeUndefined();
  });
  it.each([404, 500])('does not report missing or failed metadata as current (%s)', async status => {
    fetchMock.mockResolvedValue(new Response('', { status }));
    const updater = await import('./lexApkUpdater');
    await updater.checkLexApk();
    expect(updater.getLexApkState().phase).toBe(status === 404 ? 'unpublished' : 'error');
    expect(mocks.native.download).not.toHaveBeenCalled();
  });
  it('never downgrades an installed APK', async () => {
    mocks.native.installed.mockResolvedValue({ versionCode: 1000599 });
    const updater = await import('./lexApkUpdater'); await updater.checkLexApk();
    expect(updater.getLexApkState()).toMatchObject({ phase: 'current', target: null });
  });
  it('discards a check from the old channel even when the transport ignores abort', async () => {
    const pending = deferred<Response>(); fetchMock.mockReturnValue(pending.promise);
    const updater = await import('./lexApkUpdater'); await updater.hydrateLexApk();
    const check = updater.checkLexApk();
    await Promise.resolve();
    await updater.setLexApkChannel('release');
    pending.resolve(new Response(JSON.stringify(manifestFixture()))); await check;
    expect(updater.getLexApkState()).toMatchObject({ channel: 'release', phase: 'idle', target: null });
  });
  it('cancellation fences late download completion and removes the progress listener', async () => {
    const updater = await setupAvailable(); const pending = deferred<boolean>();
    mocks.native.download.mockReturnValue(pending.promise);
    const download = updater.downloadLexApk(); updater.cancelLexApk();
    pending.resolve(true); await download;
    expect(updater.getLexApkState().phase).toBe('available');
    expect(mocks.native.cancel).toHaveBeenCalled();
    expect(mocks.native.addListener.mock.results[0].value.remove).toHaveBeenCalled();
  });
  it('preserves downloaded state for the same manifest and opens only the system installer', async () => {
    const updater = await setupAvailable(); await updater.downloadLexApk(); await updater.checkLexApk();
    expect(updater.getLexApkState().phase).toBe('downloaded');
    await updater.installLexApk();
    expect(updater.getLexApkState().phase).toBe('installer-opened');
    expect(mocks.native.install).toHaveBeenCalledTimes(1);
  });
  it('rechecks install permission on return without assuming the APK was installed', async () => {
    const updater = await setupAvailable(); await updater.downloadLexApk();
    mocks.native.install.mockResolvedValue('permission-required'); await updater.installLexApk();
    mocks.native.canInstall.mockResolvedValue(false); await updater.refreshLexApkPermission();
    expect(updater.getLexApkState().phase).toBe('permission-required');
    mocks.native.canInstall.mockResolvedValue(true); await updater.refreshLexApkPermission();
    expect(updater.getLexApkState().phase).toBe('downloaded');
    expect(mocks.native.install).toHaveBeenCalledTimes(1);
  });
  it('shows verification failures and never starts installation after a failed download', async () => {
    const updater = await setupAvailable(); mocks.native.download.mockRejectedValue(new Error('SIGNATURE_MISMATCH'));
    await updater.downloadLexApk(); await updater.installLexApk();
    expect(updater.getLexApkState()).toMatchObject({ phase: 'error', error: 'SIGNATURE_MISMATCH' });
    expect(mocks.native.install).not.toHaveBeenCalled();
  });
  it('ignores organization beta defaults but migrates an explicit user opt-out', async () => {
    mocks.storage.set('cindy.mobile.update.beta.meta.v1', JSON.stringify({ userOverride: null, orgDefaultEnableBeta: true }));
    let updater = await import('./lexApkUpdater'); await updater.hydrateLexApk();
    expect(updater.getLexApkState().channel).toBe('beta'); // This installed binary is RC.
    expect(mocks.storage.has('lex.mobile.apk.channel.v1')).toBe(false);
    vi.resetModules(); mocks.storage.set('cindy.mobile.update.beta.meta.v1', JSON.stringify({ userOverride: false }));
    updater = await import('./lexApkUpdater'); await updater.hydrateLexApk();
    expect(updater.getLexApkState().channel).toBe('release');
  });
  it('can retry storage hydration after a transient error', async () => {
    mocks.get.mockRejectedValueOnce(new Error('storage offline'));
    const updater = await import('./lexApkUpdater');
    await expect(updater.hydrateLexApk()).rejects.toThrow('storage offline');
    await updater.hydrateLexApk(); expect(updater.getLexApkState().ready).toBe(true);
  });
});
