import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const product = vi.hoisted(() => ({ isPackaged: true, name: 'Lex' }));
const rawId = vi.hoisted(() => vi.fn(() => 'a'.repeat(64)));
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return product.isPackaged;
    },
    getName: () => product.name,
  },
}));
vi.mock('node-machine-id', () => ({ machineIdSync: rawId }));

import { deviceCredentialKey, resolveProductDeviceId } from '../productDeviceId';
import { hasPersistedSessionHint } from '../authSessionHint';

afterEach(() => {
  vi.unstubAllEnvs();
  product.isPackaged = true;
  product.name = 'Lex';
});

describe('Lex device identity', () => {
  it.each([
    ['Lex', true, undefined, 'lex_device_v1_'],
    ['Cindy', true, undefined, ''],
    ['Lex', false, undefined, ''],
    ['Cindy', false, undefined, ''],
    ['Lex', true, 'explicit-device', ''],
    ['Lex', true, '', ''],
    ['Lex', true, '   ', ''],
  ] as const)(
    'selects session-hint files for %s packaged=%s override=%j',
    (name, isPackaged, override, prefix) => {
      product.name = name;
      product.isPackaged = isPackaged;
      vi.stubEnv('XDT_DEVICE_ID_OVERRIDE', override);
      const filename = `${prefix}cindy_auth_session_v1.enc`;
      const userDataPath = path.join('/fake-user-data');
      const existsSync = vi.fn((filepath: string) => path.basename(filepath) === filename);
      const readFileSync = vi.fn(() => '{"activeMode":"signed-out"}');
      const deps = { userDataPath, existsSync, readFileSync, credentialKey: deviceCredentialKey };
      expect(hasPersistedSessionHint(deps)).toBe(true);
      expect(existsSync.mock.calls).toEqual([[path.join(userDataPath, 'safe-storage', filename)]]);
      expect(readFileSync).not.toHaveBeenCalled();
      existsSync.mockImplementation(
        (filepath) =>
          path.basename(filepath) === `${prefix ? '' : 'lex_device_v1_'}cindy_auth_session_v1.enc`,
      );
      expect(hasPersistedSessionHint(deps)).toBe(false);
    },
  );

  it('wires auth, IPC and every stored token projection to the same product identity', () => {
    const auth = fs.readFileSync(new URL('../authManager.ts', import.meta.url), 'utf8');
    const bootstrap = fs.readFileSync(new URL('../bootstrap-electron.ts', import.meta.url), 'utf8');
    expect(auth).toContain('const deviceId = getProductDeviceId();');
    expect(bootstrap).toContain('const machineId = getProductDeviceId();');
    expect(bootstrap).toMatch(
      /hasPersistedSessionHint\(\{\s*userDataPath: app.getPath\('userData'\),\s*credentialKey: deviceCredentialKey,/,
    );
    expect(auth).not.toContain("from 'node-machine-id'");
    expect(bootstrap).not.toContain("from 'node-machine-id'");
    for (const key of [
      'cindy_auth_session_v1',
      'cindy_auth_accounts_v1',
      'cindy_auth_account_logout_tombstones_v1',
      'cindy_auth_refresh_token',
      'cindy_auth_account_refresh_token',
      'refresh_token',
    ]) {
      expect(auth).toContain(`deviceCredentialKey('${key}')`);
    }
  });

  it('resolves the packaged Lex raw identity once across repeated consumers', async () => {
    vi.resetModules();
    vi.stubEnv('XDT_DEVICE_ID_OVERRIDE', undefined);
    rawId.mockClear();
    const { getProductDeviceId } = await import('../productDeviceId');
    expect(getProductDeviceId()).toBe('lex-' + 'a'.repeat(60));
    expect(getProductDeviceId()).toBe('lex-' + 'a'.repeat(60));
    expect(rawId).toHaveBeenCalledTimes(1);
  });

  it('uses a stable 64-character Lex namespace without altering Cindy or dev', () => {
    const raw = 'a'.repeat(64);
    expect(resolveProductDeviceId(raw, true, undefined)).toBe('lex-' + 'a'.repeat(60));
    expect(resolveProductDeviceId(raw, false, undefined)).toBe(raw);
    expect(resolveProductDeviceId('short', true, undefined)).toBe('lex-short');
  });

  it.each(['custom-ID', '  custom-ID  ', '', ' '.repeat(3), 'x'.repeat(80)])(
    'preserves explicit override %j exactly',
    (override) => {
      expect(resolveProductDeviceId('raw', true, override)).toBe(override);
    },
  );

  it('starts a new credential namespace once, leaving old raw-ID credentials untouched', () => {
    vi.stubEnv('XDT_DEVICE_ID_OVERRIDE', undefined);
    const credentials = new Map([['cindy_auth_session_v1', 'fake-old-credential']]);
    const key = deviceCredentialKey('cindy_auth_session_v1');
    expect(credentials.get(key)).toBeUndefined();
    credentials.set(key, 'fake-new-credential');
    expect(credentials.get(deviceCredentialKey('cindy_auth_session_v1'))).toBe(
      'fake-new-credential',
    );
    expect(credentials.get('cindy_auth_session_v1')).toBe('fake-old-credential');
    product.name = 'Cindy';
    expect(deviceCredentialKey('cindy_auth_session_v1')).toBe('cindy_auth_session_v1');
    product.name = 'Lex';
    vi.stubEnv('XDT_DEVICE_ID_OVERRIDE', 'explicit');
    expect(deviceCredentialKey('cindy_auth_session_v1')).toBe('cindy_auth_session_v1');
  });

  it('caches the same identity for auth and IPC and does not probe when overridden', async () => {
    vi.resetModules();
    vi.stubEnv('XDT_DEVICE_ID_OVERRIDE', '  unchanged  ');
    rawId.mockClear();
    const { getProductDeviceId } = await import('../productDeviceId');
    expect(getProductDeviceId()).toBe('  unchanged  ');
    expect(getProductDeviceId()).toBe('  unchanged  ');
    expect(rawId).not.toHaveBeenCalled();
  });
});
