import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const appGetPath = vi.fn();
const appGetVersion = vi.fn(() => '0.1.1');

vi.mock('electron', () => ({
  app: {
    getPath: appGetPath,
    getVersion: appGetVersion,
  },
}));

vi.mock('../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

let tempDir: string;

async function loadStore() {
  vi.resetModules();
  return import('../updateChannelStore');
}

beforeEach(() => {
  appGetVersion.mockReset();
  appGetVersion.mockReturnValue('0.1.1');
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-update-channel-'));
  appGetPath.mockImplementation((name: string) => {
    if (name === 'userData') return tempDir;
    return tempDir;
  });
});

describe('build-version defaults', () => {
  it('fails closed when a minimal Electron host does not expose a version', async () => {
    appGetVersion.mockReturnValue(undefined as unknown as string);
    const store = await loadStore();

    expect(store.readUpdateChannelSettings().enableBeta).toBe(false);
  });

  it('defaults a prerelease installer to beta without persisting an override', async () => {
    appGetVersion.mockReturnValue('0.1.1-rc.1');
    const store = await loadStore();

    expect(store.readUpdateChannelSettings()).toEqual({
      enableBeta: true,
      orgDefaultEnableBeta: false,
    });
    expect(store.readUpdateChannelSettingsState().customizedKeys).toEqual([]);
    expect(fs.existsSync(path.join(tempDir, 'update-channel-settings.json'))).toBe(false);
  });

  it('preserves an explicit prerelease opt-out', async () => {
    appGetVersion.mockReturnValue('0.1.1-rc.1');
    const store = await loadStore();

    await store.writeEnableBeta(false);

    expect(store.readUpdateChannelSettings().enableBeta).toBe(false);
    expect(store.isEnableBetaUserCustomized()).toBe(true);
  });
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('tryEnableUncustomizedBetaAtomic', () => {
  it('turns beta on via org default without writing a user enableBeta override', async () => {
    const store = await loadStore();

    expect(store.readUpdateChannelSettingsState()).toMatchObject({
      value: { enableBeta: false, orgDefaultEnableBeta: false },
      customizedKeys: [],
    });
    expect(await store.tryEnableUncustomizedBetaAtomic()).toBe(true);
    expect(store.readUpdateChannelSettings()).toEqual({
      enableBeta: true,
      orgDefaultEnableBeta: true,
    });
    expect(store.isEnableBetaUserCustomized()).toBe(false);
    expect(store.readUpdateChannelSettingsState().customizedKeys).toEqual(['orgDefaultEnableBeta']);
  });

  it('does not reopen beta after the user turned it off', async () => {
    const store = await loadStore();
    await store.writeEnableBeta(true);
    await store.writeEnableBeta(false);

    expect(store.readUpdateChannelSettings()).toMatchObject({ enableBeta: false });
    expect(store.isEnableBetaUserCustomized()).toBe(true);
    expect(await store.tryEnableUncustomizedBetaAtomic()).toBe(false);
    expect(store.readUpdateChannelSettings().enableBeta).toBe(false);
  });

  it('keeps a never-enabled opt-out as a user choice', async () => {
    const store = await loadStore();
    await store.writeEnableBeta(false);

    expect(store.isEnableBetaUserCustomized()).toBe(true);
    expect(await store.tryEnableUncustomizedBetaAtomic()).toBe(false);
    expect(store.readUpdateChannelSettings().enableBeta).toBe(false);
  });

  it('is a no-op when beta is already on', async () => {
    const store = await loadStore();
    await store.writeEnableBeta(true);

    expect(await store.tryEnableUncustomizedBetaAtomic()).toBe(false);
    expect(store.readUpdateChannelSettings().enableBeta).toBe(true);
    expect(store.isEnableBetaUserCustomized()).toBe(true);
  });

  it('does not write when the lock-time identity guard rejects', async () => {
    const store = await loadStore();
    expect(await store.tryEnableUncustomizedBetaAtomic(() => false)).toBe(false);
    expect(store.readUpdateChannelSettings()).toEqual({
      enableBeta: false,
      orgDefaultEnableBeta: false,
    });
  });
});

describe('Beta channel build capability', () => {
  const originalPlatform = process.platform;
  const originalArch = process.arch;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    Object.defineProperty(process, 'arch', { value: originalArch, configurable: true });
  });

  it('allows Linux x64 to use a persisted beta setting', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
    const store = await loadStore();
    await store.writeEnableBeta(true);

    expect(store.readUpdateChannelSettings().enableBeta).toBe(true);
    expect(store.isBetaChannelEnabled()).toBe(true);
  });

  it('keeps Linux arm64 on the release channel even when disk says beta is on', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
    const store = await loadStore();
    await store.writeEnableBeta(true);

    expect(store.readUpdateChannelSettings().enableBeta).toBe(true);
    expect(store.isBetaChannelEnabled()).toBe(false);
  });

  it('keeps the existing beta behavior on non-Linux builds', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
    const store = await loadStore();
    await store.writeEnableBeta(true);

    expect(store.isBetaChannelEnabled()).toBe(true);
  });
});
