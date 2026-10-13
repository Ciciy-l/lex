import { describe, expect, it } from 'vitest';
import { runtimeArtifactFormat, runtimeAssetPlatform } from '../artifact-format.js';

describe('build-pinned runtime encodings', () => {
  it('keeps old CDN gzip while accepting official raw Claude and OMP', () => {
    expect(runtimeArtifactFormat('claude-code/2.1.259/win32-x64/claude.exe.gz', 'gz')).toBe('gz');
    expect(
      runtimeArtifactFormat(
        'https://downloads.claude.ai/claude-code-releases/2.1.296/win32-x64/claude.exe',
        'gz',
      ),
    ).toBe('binary');
    expect(
      runtimeArtifactFormat(
        'https://github.com/can1357/oh-my-pi/releases/download/v18.10.3/omp-linux-x64',
        'raw',
      ),
    ).toBe('binary');
  });
  it('distinguishes Pi Windows ZIP from Pi/Codex and legacy directory tarballs', () => {
    expect(
      runtimeArtifactFormat(
        'https://github.com/earendil-works/pi/releases/download/v1.2.0/pi-windows-x64.zip',
        'tar-gz-dir',
      ),
    ).toBe('zip');
    for (const file of [
      'pi/0.84.4/linux-x64/pi.dist.tar.gz',
      'https://github.com/openai/codex/releases/download/rust-v0.162.1/codex-package-x86_64-unknown-linux-musl.tar.gz',
    ])
      expect(runtimeArtifactFormat(file, 'tar-gz-dir')).toBe('tar.gz');
    expect(() => runtimeArtifactFormat('pi.exe', 'tar-gz-dir')).toThrow(
      'Unsupported runtime archive format',
    );
  });
  it.each([
    ['pi/0.84.4/win32-arm64/pi.dist.tar.gz', 'win32-arm64'],
    [
      'https://downloads.claude.ai/claude-code-releases/2.1.296/darwin-arm64/claude',
      'darwin-arm64',
    ],
    [
      'https://github.com/earendil-works/pi/releases/download/v1.2.0/pi-windows-x64.zip',
      'win32-x64',
    ],
    [
      'https://github.com/can1357/oh-my-pi/releases/download/v18.10.3/omp-linux-arm64',
      'linux-arm64',
    ],
    [
      'https://github.com/openai/codex/releases/download/rust-v0.162.1/codex-package-x86_64-pc-windows-msvc.tar.gz',
      'win32-x64',
    ],
    [
      'https://github.com/openai/codex/releases/download/rust-v0.162.1/codex-package-aarch64-apple-darwin.tar.gz',
      'darwin-arm64',
    ],
  ])('retains the platform gate for %s', (file, platform) => {
    expect(runtimeAssetPlatform(file)).toBe(platform);
  });
});
