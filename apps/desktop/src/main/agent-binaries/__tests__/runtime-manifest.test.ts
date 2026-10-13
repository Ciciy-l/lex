import codexRelease from '../../../../../../tools/codex-package/latest.json';
import piRelease from '../../../../../../tools/pi/latest.json';
import { describe, expect, it } from 'vitest';

import {
  getRuntimeAssetBaseUrl,
  getRuntimeManifest,
} from '../runtime-manifest.js';
import { getPinnedOmpRuntimeAsset } from '../../maker-host/omp-runtime-verifier.js';

describe('build-pinned agent runtime manifest', () => {
  it.each(['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64'])(
    'contains required managed runtimes for %s',
    (platform) => {
      const manifest = getRuntimeManifest(platform);

      expect(manifest).not.toBeNull();
      expect(manifest?.claudeCode?.file).toContain(`/${platform}/`);
      const codex = codexRelease.runtimeAssets[platform as keyof typeof codexRelease.runtimeAssets];
      expect(manifest?.codexPackage).toEqual({ version: codexRelease.version, file: codex.url, sha256: codex.sha256, size: codex.size });
      const pi = piRelease.runtimeAssets[platform as keyof typeof piRelease.runtimeAssets];
      expect(manifest?.pi).toEqual({
        version: piRelease.version,
        file: pi.url,
        sha256: pi.sha256,
        size: pi.size,
      });
      const omp = getPinnedOmpRuntimeAsset(platform);
      expect(omp).toBeDefined();
      expect(manifest?.omp).toEqual({
        version: '18.10.4',
        file: omp?.url,
        sha256: omp?.sha256,
        size: omp?.size,
      });
    },
  );

  it('returns null for a platform not shipped by Lex', () => {
    expect(getRuntimeManifest('win32-arm64')).toBeNull();
  });

  it('returns detached data so a caller cannot pollute the build snapshot', () => {
    const first = getRuntimeManifest('win32-x64');
    expect(first?.claudeCode).toBeDefined();
    first!.claudeCode!.version = 'mutated';

    expect(getRuntimeManifest('win32-x64')?.claudeCode?.version).toBe('2.1.296');
  });

  it('uses the audited Cindy CDN base without a trailing slash', () => {
    expect(getRuntimeAssetBaseUrl()).toBe('https://hotfix.cindy.app/cindy');
  });

  it('keeps the legacy standalone pin distinct from the desktop package pin', () => {
    const manifest = getRuntimeManifest('win32-x64');

    expect(manifest?.codexPackage?.version).toBe('0.162.1');
    expect(manifest?.codex?.version).toBe('0.145.0');
    expect(manifest?.codex?.version).not.toBe(manifest?.codexPackage?.version);
  });
});
