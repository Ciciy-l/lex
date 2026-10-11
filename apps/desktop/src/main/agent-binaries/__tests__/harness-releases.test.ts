import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ net: { fetch: vi.fn() } }));
vi.mock('../../manifestService.js', () => ({
  resolveManifestAssetUrl: (base: string, file: string) => new URL(file, base + '/').href,
}));
import { parseGithubArtifact, stableVersion, baselineArtifact } from '../harness-releases.js';

function release(kind: 'codex' | 'omp') {
  const tag = kind === 'codex' ? 'rust-v0.160.0' : 'v18.2.0';
  const repo = kind === 'codex' ? 'openai/codex' : 'can1357/oh-my-pi';
  const name =
    kind === 'codex' ? 'codex-package-x86_64-pc-windows-msvc.tar.gz' : 'omp-windows-x64.exe';
  return {
    tag_name: tag,
    assets: [
      {
        name,
        digest: 'sha256:' + 'a'.repeat(64),
        browser_download_url:
          'https://github.com/' + repo + '/releases/download/' + tag + '/' + name,
      },
    ],
  };
}
describe('official Harness releases', () => {
  it('accepts the full Codex package and raw OMP artifact with official digests', () => {
    expect(parseGithubArtifact('codex', release('codex'), 'win32', 'x64').executable).toBe(
      'bin/codex.exe',
    );
    expect(parseGithubArtifact('omp', release('omp'), 'win32', 'x64')).toMatchObject({
      version: '18.2.0',
      format: 'binary',
      executable: 'omp.exe',
    });
  });
  it('rejects prereleases, single-binary Codex assets, missing digests and substituted URLs', () => {
    expect(() =>
      parseGithubArtifact('omp', { ...release('omp'), prerelease: true }, 'win32', 'x64'),
    ).toThrow();
    for (const patch of [
      { name: 'codex-x86_64-pc-windows-msvc.exe' },
      { digest: undefined },
      { browser_download_url: 'https://example.com/codex.exe' },
    ]) {
      const raw = release('codex');
      Object.assign(raw.assets[0], patch);
      expect(() => parseGithubArtifact('codex', raw, 'win32', 'x64')).toThrow();
    }
    for (const value of ['v18.2.0-beta.1', 'v../18.2.0', 'v18x2x0', 'v18.2'])
      expect(() => stableVersion(value)).toThrow();
  });
  it('keeps recovery metadata tied to the Lex build snapshot', () => {
    const baseline = baselineArtifact('codex');
    if (baseline)
      expect(baseline).toMatchObject({ source: 'baseline', format: 'tar.gz', version: '0.159.2' });
  });
});
