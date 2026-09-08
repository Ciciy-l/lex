import { describe, expect, it } from 'vitest';

import {
  getRuntimeAssetBaseUrl,
  getRuntimeManifest,
} from '../runtime-manifest.js';

describe('build-pinned agent runtime manifest', () => {
  it.each(['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64'])(
    'contains required managed runtimes for %s',
    (platform) => {
      const manifest = getRuntimeManifest(platform);

      expect(manifest).not.toBeNull();
      expect(manifest?.claudeCode?.file).toContain(`/${platform}/`);
      expect(manifest?.codexPackage?.file).toContain(`/${platform}/`);
      expect(manifest?.pi?.file).toContain(`/${platform}/`);
    },
  );

  it('returns null for a platform not shipped by Lex', () => {
    expect(getRuntimeManifest('win32-arm64')).toBeNull();
  });

  it('returns detached data so a caller cannot pollute the build snapshot', () => {
    const first = getRuntimeManifest('win32-x64');
    expect(first?.claudeCode).toBeDefined();
    first!.claudeCode!.version = 'mutated';

    expect(getRuntimeManifest('win32-x64')?.claudeCode?.version).toBe('2.1.259');
  });

  it('uses the audited Cindy CDN base without a trailing slash', () => {
    expect(getRuntimeAssetBaseUrl()).toBe('https://hotfix.cindy.app/cindy');
  });
});
