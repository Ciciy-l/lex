import { describe, expect, it } from 'vitest';
import { defaultLexUpdateChannel, lexAndroidVersionCode, parseLexApkManifest, lexApkNotes } from './lexApkModel';
import { androidVersionCode } from '../../../../scripts/shared/lex-mobile-config.cjs';

import { manifestFixture } from './lexApkTestFixture';

describe('Lex APK manifest', () => {
  it('keeps the installed Android allocation through RC, stable and the next RC', () => {
    const versions = ['0.1.4-alpha.1', '0.1.4-beta.1', '0.1.4-rc.1', '0.1.4-rc.29', '0.1.4', '0.1.5-rc.1', '20.99.9999'];
    const codes = versions.map(lexAndroidVersionCode);
    expect(codes).toEqual(versions.map(androidVersionCode));
    expect(codes).toEqual([...codes].sort((a, b) => a - b));
    expect(defaultLexUpdateChannel('0.1.4')).toBe('release');
    expect(defaultLexUpdateChannel('0.1.5-rc.1')).toBe('beta');
  });
  it('accepts RC only on beta; stable can graduate either channel', () => {
    expect(() => parseLexApkManifest(manifestFixture(), 'release')).toThrow('INVALID_METADATA');
    expect(parseLexApkManifest(manifestFixture(), 'beta').version).toBe('0.1.5-rc.1');
    for (const channel of ['beta', 'release'] as const) {
      const parsed = parseLexApkManifest(manifestFixture('0.1.5'), channel);
      expect(lexApkNotes(parsed, 'ja')).toContain('Lex ja');
      expect(lexApkNotes(parsed, 'unknown')).toContain('Lex en');
    }
  });
  it.each([
    { packageName: 'com.xd.cindy' }, { file: 'https://example.com/Lex.apk' },
    { releaseUrl: 'https://github.com/other/lex/releases' }, { size: 0 }, { size: 8 * 1024 ** 3 + 1 },
    { sha256: 'invalid' }, { certificateSha256: '' }, { versionCode: 1 },
    { version: '../other' }, { version: '0.1.5-rc.30' }, { contentByLocale: {} },
  ])('rejects mismatched or incomplete release metadata: %j', patch => {
    expect(() => parseLexApkManifest({ ...manifestFixture(), ...patch }, 'beta')).toThrow('INVALID_METADATA');
  });
});
