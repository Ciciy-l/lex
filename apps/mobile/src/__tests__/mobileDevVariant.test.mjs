// Node-only development tools; no React Native runtime or emulator is started.
import { describe, expect, it, vi } from 'vitest';
import { extractMobileDevVariantArgs, mobileSimulatorBuildEnv } from '../../scripts/lib/mobile-dev-variant.mjs';
import { extractAndroidSerialArgs, inspectAndroidDevelopmentClient } from '../../scripts/lib/android-whoami.mjs';
import { lexMobileConfig } from '../../../../scripts/shared/lex-mobile-config.cjs';

describe('official Lex Android development target', () => {
  it('keeps Cindy local configuration and isolates the explicit Lex variant', () => {
    expect(extractMobileDevVariantArgs(['--lex', '--build-only'])).toEqual({ lex: true, passthrough: ['--build-only'] });
    expect(() => extractMobileDevVariantArgs(['--lex', '--lex'])).toThrow();
    expect(mobileSimulatorBuildEnv('global').CINDY_USE_LOCAL_REGION_CONFIG).toBe('1');
    const lex = mobileSimulatorBuildEnv('global', { lex: true, platform: 'win32' });
    expect(lex.LEX_MOBILE_BUILD).toBe('1');
    expect(lex.CINDY_USE_LOCAL_REGION_CONFIG).toBeUndefined();
    const config = { plugins: [], ios: {}, android: {} };
    expect(lexMobileConfig(config, lex)).toMatchObject({ slug: 'lex-mobile', android: { package: 'io.github.ciciyl.lex' }, updates: { enabled: false } });
    expect(() => lexMobileConfig(config, { ...lex, EAS_OWNER: 'fixture' })).toThrow('cannot inherit');
    expect(() => mobileSimulatorBuildEnv('global', { lex: true, platform: 'darwin' })).toThrow('Android');
  });
  it('requires an explicit Android serial and rejects stale/foreign Metro or non-debug packages', async () => {
    expect(extractAndroidSerialArgs(['--serial', 'emulator-5560'])).toEqual({ serial: 'emulator-5560', passthrough: [] });
    expect(() => extractAndroidSerialArgs(['--serial', 'physical-device'])).toThrow();
    const target = { serial: 'emulator-5560', bundleId: 'fixture.app', port: 8081, source: 'candidate', worktree: 'F:/fixture' };
    const run = vi.fn(args => args[0] === 'get-state' ? 'device' : args[1] === 'pidof' ? '123' : 'versionName=0.1.7 versionCode=10799 pkgFlags=[ DEBUGGABLE ]');
    const tools = { adb: 'fixture-adb' };
    await expect(inspectAndroidDevelopmentClient(target, { tools, run, probe: () => ({ cwd: 'F:/fixture/apps/mobile', source: 'candidate' }) })).resolves.toMatchObject({ healthy: true });
    await expect(inspectAndroidDevelopmentClient(target, { tools, run, probe: () => ({ cwd: 'F:/other/apps/mobile', source: 'candidate' }) })).resolves.toMatchObject({ healthy: false });
    await expect(inspectAndroidDevelopmentClient(target, { tools, run, probe: () => ({ cwd: 'F:/fixture/apps/mobile', source: 'stale' }) })).resolves.toMatchObject({ healthy: false });
    run.mockImplementation(args => args[0] === 'get-state' ? 'device' : args[1] === 'pidof' ? '123' : 'versionName=0.1.7 versionCode=10799 pkgFlags=[ ]');
    await expect(inspectAndroidDevelopmentClient(target, { tools, run, probe: () => ({ cwd: 'F:/fixture/apps/mobile', source: 'candidate' }) })).resolves.toMatchObject({ healthy: false });
  });
});
