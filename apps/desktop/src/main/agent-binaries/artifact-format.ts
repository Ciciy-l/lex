import type { BinaryProvisionerConfig } from './types.js';

/** Select the published encoding, including the older CDN gzip distributions. */
export function runtimeArtifactFormat(
  file: string,
  kind: BinaryProvisionerConfig['artifact']['kind'],
): 'binary' | 'gz' | 'tar.gz' | 'zip' {
  const pathname = new URL(file, 'https://runtime.invalid/').pathname;
  if (kind === 'raw') return 'binary';
  if (kind === 'gz') return pathname.endsWith('.gz') ? 'gz' : 'binary';
  if (pathname.endsWith('.zip')) return 'zip';
  if (pathname.endsWith('.tar.gz')) return 'tar.gz';
  throw new Error('Unsupported runtime archive format');
}

/** Old CDN paths and official publisher filenames both pin a platform. */
export function runtimeAssetPlatform(file: string): string | undefined {
  const pathname = new URL(file, 'https://runtime.invalid/').pathname;
  const segment = pathname.match(
    /\/(linux-x64|linux-arm64|darwin-arm64|darwin-x64|win32-x64|win32-arm64)\//,
  )?.[1];
  if (segment) return segment;
  const name = pathname.slice(pathname.lastIndexOf('/') + 1);
  const native = name.match(/(?:^|-)(windows|darwin|linux)-(x64|arm64)(?:\.|$)/);
  if (native) return (native[1] === 'windows' ? 'win32' : native[1]) + '-' + native[2];
  const target = name.match(
    /(x86_64|aarch64)-(pc-windows-msvc|apple-darwin|unknown-linux-(?:musl|gnu))/,
  );
  if (!target) return undefined;
  const platform = target[2].startsWith('pc-windows')
    ? 'win32'
    : target[2] === 'apple-darwin'
      ? 'darwin'
      : 'linux';
  return platform + '-' + (target[1] === 'aarch64' ? 'arm64' : 'x64');
}
