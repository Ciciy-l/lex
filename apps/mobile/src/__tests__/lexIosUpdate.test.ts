import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { iosBuildNumber, isNewerIosRelease, parseLexIosManifest } from '../update/lexIosModel';
const mocks = vi.hoisted(() => ({ os: 'ios', system: '17.0', storage: new Map<string, string>(), open: vi.fn(), fetch: vi.fn(), write: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { get OS() { return mocks.os; }, get Version() { return mocks.system; } }, Linking: { openURL: mocks.open } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { slug: 'lex-mobile', version: '0.1.0-rc.1', ios: { buildNumber: '2.0.61' } } } }));
vi.mock('expo-application', () => ({ nativeApplicationVersion: '0.1.0', nativeBuildVersion: '2.0.61' }));
vi.mock('expo/fetch', () => ({ fetch: mocks.fetch }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async (key: string) => mocks.storage.get(key) ?? null,
  setItem: (key: string, value: string) => mocks.write(key, value),
} }));
function manifest(version = '0.2.0') {
  return { schemaVersion: 1, platform: 'ios', signing: 'unsigned', version, shortVersion: version.split('-')[0], buildNumber: iosBuildNumber(version),
    bundleIdentifier: 'io.github.ciciyl.lex', minimumOSVersion: '16.4', size: 1234, sha256: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), sourceDirty: false,
    file: 'https://github.com/Ciciy-l/lex/releases/download/v' + version + '/Lex-' + version + '-iOS-unsigned.ipa',
    releaseUrl: 'https://github.com/Ciciy-l/lex/releases/tag/v' + version,
    contentByLocale: Object.fromEntries(['en', 'zh-CN', 'zh-TW', 'ja', 'ko'].map(locale => [locale, { intro: locale, topics: [{ title: 'Changes', text: 'Details' }] }])) };
}
beforeEach(() => {
  vi.resetModules(); mocks.storage.clear(); mocks.os = 'ios'; mocks.system = '17.0'; mocks.open.mockReset().mockResolvedValue(undefined);
  mocks.write.mockReset().mockImplementation(async (key, value) => { mocks.storage.set(key, value); });
  mocks.fetch.mockReset().mockImplementation(async () => new Response(JSON.stringify(manifest())));
});
afterEach(() => vi.restoreAllMocks());
describe('iOS update trust and ordering', () => {
  it('rejects arbitrary URLs, query credentials, wrong packages, bad builds and stable/RC confusion', () => {
    for (const patch of [{ file: 'https://evil.invalid/a.ipa' }, { file: manifest().file + '?token=synthetic' },
      { bundleIdentifier: 'other' }, { buildNumber: '9.9.9' }, { minimumOSVersion: 'bad' }, { contentByLocale: {} }, { sha256: 'bad' }, { sourceDirty: true }]) {
      expect(() => parseLexIosManifest({ ...manifest(), ...patch }, 'release')).toThrow('INVALID_METADATA');
    }
    expect(() => parseLexIosManifest(manifest('0.2.0-rc.1'), 'release')).toThrow();
    const target = parseLexIosManifest(manifest('0.2.0'), 'release');
    expect(isNewerIosRelease(target, '0.2.0-rc.1', '3.0.61')).toBe(true);
    expect(isNewerIosRelease(target, '0.2.0', '3.0.98')).toBe(true);
    expect(isNewerIosRelease(target, '0.2.0', '3.0.99')).toBe(false);
    expect(isNewerIosRelease(target, '0.3.0-rc.1', '4.0.61')).toBe(false);
  });
  it('defaults RC to beta and never carries cookies or service credentials', async () => {
    const updater = await import('../update/lexIosUpdater'); await updater.checkLexIos();
    expect(updater.getLexIosState()).toMatchObject({ phase: 'available', channel: 'beta' });
    expect(mocks.fetch).toHaveBeenCalledWith(expect.stringContaining('/manifest-ios-beta.json?t='), {
      credentials: 'omit', redirect: 'error', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    }); // Exact supported Expo options: no browser-only cache field or credential headers.
    const firstUrl = new URL(mocks.fetch.mock.calls[0][0]);
    expect(Number(firstUrl.searchParams.get('t'))).toBeGreaterThan(0);
    const target = updater.getLexIosState().target!; await updater.downloadLexIos(target);
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith(target.file);
    expect(updater.getLexIosState().phase).toBe('available'); // Opening Safari is not installation.
  });
  it('limits automatic checks/reminders, honors ignores, and still permits manual checks', async () => {
    const u = await import('../update/lexIosUpdater'); await u.checkLexIos(false); await u.checkLexIos(false);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const target = await u.claimLexIosReminder(); expect(target).not.toBeNull(); expect(await u.claimLexIosReminder()).toBeNull();
    await u.ignoreLexIos(target!); expect(u.getLexIosState().phase).toBe('ignored');
    await u.checkLexIos(); expect(u.getLexIosState().phase).toBe('available'); expect(await u.claimLexIosReminder()).toBeNull();
  });
  it('does not offer incompatible downloads and distinguishes unpublished, invalid and offline', async () => {
    mocks.system = '15.0'; const u = await import('../update/lexIosUpdater'); await u.checkLexIos();
    expect(u.getLexIosState().phase).toBe('incompatible'); await u.downloadLexIos(u.getLexIosState().target!); expect(mocks.open).not.toHaveBeenCalled();
    mocks.fetch.mockResolvedValueOnce(new Response('', { status: 404 })); await u.checkLexIos(); expect(u.getLexIosState().phase).toBe('unpublished');
    mocks.fetch.mockResolvedValueOnce(new Response('not JSON')); await u.checkLexIos(); expect(u.getLexIosState().error).toBe('INVALID_METADATA');
    mocks.fetch.mockRejectedValueOnce(new Error('offline')); await u.checkLexIos(); expect(u.getLexIosState()).toMatchObject({ error: 'CHECK_FAILED', target: null });
  });
  it('rejects oversized metadata and redirect responses', async () => {
    const u = await import('../update/lexIosUpdater');
    mocks.fetch.mockResolvedValueOnce(new Response(' '.repeat(256 * 1024 + 1))); await u.checkLexIos(); expect(u.getLexIosState().error).toBe('INVALID_METADATA');
    const response = new Response(JSON.stringify(manifest())); Object.defineProperty(response, 'redirected', { value: true });
    mocks.fetch.mockResolvedValueOnce(response); await u.checkLexIos(); expect(u.getLexIosState().error).toBe('INVALID_METADATA');
  });
  it('discards a late beta response after a channel change and preserves failed preference writes', async () => {
    const u = await import('../update/lexIosUpdater'); let finish!: (value: Response) => void;
    mocks.fetch.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const flight = u.checkLexIos(); await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    await u.setLexIosChannel('release'); finish(new Response(JSON.stringify(manifest('0.2.0-rc.1')))); await flight;
    expect(u.getLexIosState()).toMatchObject({ channel: 'release', target: null });
    mocks.write.mockRejectedValueOnce(new Error('storage')); await u.setLexIosChannel('beta');
    expect(u.getLexIosState()).toMatchObject({ channel: 'release', error: 'STORAGE_FAILED' });
  });
  it('leaves Android on its own updater', async () => {
    mocks.os = 'android'; const u = await import('../update/lexIosUpdater'); await u.checkLexIos(); expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('a manual check joins a quiet check but still reveals an ignored version', async () => {
    mocks.storage.set('lex.mobile.ios.update.v1.ignored', manifest().sha256);
    const u = await import('../update/lexIosUpdater'); let finish!: (value: Response) => void;
    mocks.fetch.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const quiet = u.checkLexIos(false); await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    const manual = u.checkLexIos();
    finish(new Response(JSON.stringify(manifest()))); await Promise.all([quiet, manual]);
    expect(u.getLexIosState().phase).toBe('available'); expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it('does not navigate or save an ignore from a stale update alert', async () => {
    const u = await import('../update/lexIosUpdater'); await u.checkLexIos();
    const target = u.getLexIosState().target!; await u.setLexIosChannel('release');
    await u.downloadLexIos(target); await u.ignoreLexIos(target);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.storage.has('lex.mobile.ios.update.v1.ignored')).toBe(false);
  });
});
