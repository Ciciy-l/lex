// @vitest-environment jsdom
import React, { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LexMobileInfoSection, LexMobileUpdateBridge } from '../update/LexMobileUpdate';

const m = vi.hoisted(() => ({
  ios: true, phase: 'available', state: {} as Record<string, unknown>, appState: 'active',
  appListener: (_value: string) => {}, check: vi.fn(), claim: vi.fn(), download: vi.fn(),
  ignore: vi.fn(), channel: vi.fn(), open: vi.fn(), alert: vi.fn(), androidCheck: vi.fn(), androidDownload: vi.fn(),
  androidState: { ready: true, phase: 'available', channel: 'release', target: null, error: null },
}));
const target = { version: '0.1.15', size: 100, minimumOSVersion: '16.4',
  file: 'https://github.com/Ciciy-l/lex/releases/download/v0.1.15/Lex-0.1.15-iOS-unsigned.ipa',
  releaseUrl: 'https://github.com/Ciciy-l/lex/releases/tag/v0.1.15',
  contentByLocale: { en: { intro: 'Lex', topics: [{ title: 'Changes', text: 'Details' }] } } };
vi.mock('react-native', () => ({ Alert: { alert: m.alert }, Linking: { openURL: m.open },
  AppState: { get currentState() { return m.appState; }, addEventListener: (_name: string, listener: typeof m.appListener) => {
    m.appListener = listener; return { remove: vi.fn() };
  } },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/config/env', () => ({ APP_BINARY_VERSION: '0.1.14' }));
vi.mock('@/config/lexMobile', () => ({ IS_LEX_MOBILE: true, LEX_PRODUCT: {} }));
vi.mock('@/auth/loginMessages', () => ({ getLoginLanguage: () => 'en' }));
vi.mock('@/session/SettingsGroupRows', () => ({
  SettingsGroup: ({ children, footer }: { children: ReactNode; footer?: string }) => <section>{children}<p>{footer}</p></section>,
  InfoRow: ({ label, value, detail }: { label: string; value: string; detail?: string }) => <p>{label} {value} {detail}</p>,
  ActionInfoRow: ({ label, detail, disabled, onPress }: { label: string; detail?: string; disabled?: boolean; onPress(): void }) =>
    <button disabled={disabled} onClick={onPress}>{label} {detail}</button>,
  SettingsSwitchRow: ({ label, disabled, onValueChange }: { label: string; disabled?: boolean; onValueChange(value: boolean): void }) =>
    <button disabled={disabled} onClick={() => onValueChange(true)}>{label}</button>,
}));
vi.mock('../update/lexIosUpdater', () => ({
  get lexIosAvailable() { return m.ios; }, lexIosInstalledVersion: '0.1.14', lexIosInstalledBuild: '2.14.99',
  getLexIosState: () => m.state, subscribeLexIos: () => () => {}, hydrateLexIos: async () => {},
  checkLexIos: m.check, claimLexIosReminder: m.claim, downloadLexIos: m.download, ignoreLexIos: m.ignore, setLexIosChannel: m.channel,
}));
vi.mock('../update/lexApkUpdater', () => ({
  get lexApkAvailable() { return !m.ios; }, getLexApkState: () => m.androidState, subscribeLexApk: () => () => {},
  hydrateLexApk: async () => {}, checkLexApk: m.androidCheck, claimLexApkReminder: async () => null,
  downloadLexApk: m.androidDownload, installLexApk: vi.fn(), cancelLexApk: vi.fn(),
  setLexApkChannel: async () => {}, openLexInstallPermission: vi.fn(), refreshLexApkPermission: vi.fn(),
}));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); m.ios = true; m.appState = 'active'; m.state = { ready: true, phase: 'available', channel: 'release', target, error: null };
  m.channel.mockResolvedValue(true); m.check.mockResolvedValue(undefined); m.claim.mockResolvedValue(target); m.open.mockResolvedValue(undefined);
  m.androidCheck.mockResolvedValue(undefined);
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
function button(key: string) { return [...container.querySelectorAll('button')].find(node => node.textContent?.includes(key)); }
it('offers IPA download and help, without Android installation controls', async () => {
  await act(async () => root.render(<LexMobileInfoSection />));
  expect(button('update.lex.ios.download')).toBeTruthy(); expect(button('update.lex.install')).toBeUndefined();
  expect(container.textContent).toContain('update.lex.ios.installHint');
  expect(m.download).not.toHaveBeenCalled(); expect(m.open).not.toHaveBeenCalled();
  await act(async () => button('update.lex.ios.download')!.click()); expect(m.download).toHaveBeenCalledWith(target);
  await act(async () => button('update.lex.ios.help')!.click());
  expect(m.open).toHaveBeenCalledWith('https://github.com/Ciciy-l/lex/blob/main/docs/lex-ios-distribution.md');
});
it('shows incompatible system guidance and preserves failed channel preferences', async () => {
  m.state = { ...m.state, phase: 'incompatible' }; m.channel.mockResolvedValue(false);
  await act(async () => root.render(<LexMobileInfoSection />));
  expect(button('update.lex.ios.download')).toBeUndefined(); expect(container.textContent).toContain('update.lex.ios.incompatible');
  await act(async () => button('update.lex.beta')!.click()); expect(m.check).not.toHaveBeenCalled();
});
it('startup/foreground checks use the iOS bridge and do not download automatically', async () => {
  vi.useFakeTimers(); await act(async () => root.render(<LexMobileUpdateBridge />));
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(m.check).toHaveBeenCalledExactlyOnceWith(false); expect(m.androidCheck).not.toHaveBeenCalled();
  const buttons = m.alert.mock.calls[0][2] as Array<{ text: string }>;
  expect(buttons.map(item => item.text)).toContain('update.lex.ios.download');
  expect(m.download).not.toHaveBeenCalled();
  await act(async () => { m.appState = 'background'; m.appListener('background'); m.appState = 'active'; m.appListener('active'); });
  expect(m.check).toHaveBeenCalledTimes(2);
});
it('keeps Android version checks on the APK updater', async () => {
  m.ios = false; await act(async () => root.render(<LexMobileInfoSection />));
  expect(button('update.lex.ios.help')).toBeUndefined();
  await act(async () => button('update.lex.check')!.click());
  expect(m.androidCheck).toHaveBeenCalledTimes(1); expect(m.check).not.toHaveBeenCalled();
});
