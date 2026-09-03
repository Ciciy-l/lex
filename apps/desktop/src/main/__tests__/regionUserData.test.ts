import { describe, expect, it } from 'vitest';
import { resolveRegionUserDataDirName } from '../regionUserData';

/**
 * Lex 单发行版核心不变量：cn/global 兼容构建参数必须落到同一个正式 profile；
 * dev 仍独立。此模块跑在 main 入口最早期，所以把所有象限锁死。
 */
describe('resolveRegionUserDataDirName', () => {
  const ARGV = ['Lex.exe'] as const;

  it('packaged + global → 唯一正式 LexGlobal profile', () => {
    expect(
      resolveRegionUserDataDirName({ isPackaged: true, region: 'global', argv: ARGV }),
    ).toBe('LexGlobal');
  });

  it('packaged + cn 兼容参数 → 同一个 LexGlobal profile', () => {
    expect(
      resolveRegionUserDataDirName({ isPackaged: true, region: 'cn', argv: ARGV }),
    ).toBe('LexGlobal');
  });

  it('dev(非 packaged)按区域选择正式 profile，隔离沙箱再基于它派生', () => {
    expect(
      resolveRegionUserDataDirName({ isPackaged: false, region: 'cn', argv: ARGV }),
    ).toBe('LexGlobal');
    expect(
      resolveRegionUserDataDirName({ isPackaged: false, region: 'global', argv: ARGV }),
    ).toBe('LexGlobal');
    expect(
      resolveRegionUserDataDirName({ isPackaged: false, region: 'dev', argv: ARGV }),
    ).toBe('LexDev');
  });

  it('显式 Chromium --user-data-dir 时不覆写,尊重调用方', () => {
    expect(
      resolveRegionUserDataDirName({
        isPackaged: true,
        region: 'global',
        argv: ['Lex.exe', '--smoke-test', '--user-data-dir=C:\\tmp\\xdt-smoke-x'],
      }),
    ).toBeNull();
    expect(
      resolveRegionUserDataDirName({
        isPackaged: true,
        region: 'global',
        argv: ['Lex.exe', '--user-data-dir', 'C:\\tmp\\xdt-smoke-x'],
      }),
    ).toBeNull();
  });

  it('XDT_USER_DATA_DIR 仍保留区域默认 profile 作为隔离 epoch 基线', () => {
    expect(
      resolveRegionUserDataDirName({
        isPackaged: false,
        region: 'global',
        argv: ARGV,
        envUserDataDir: '/tmp/custom-profile',
      }),
    ).toBe('LexGlobal');
  });
});
