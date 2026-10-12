import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(import.meta.dirname, '../../../..');
const hostRoot = path.join(desktopRoot, 'native', 'remote-desktop', 'windows-host');

async function readHostManifest() {
  return parse(await readFile(path.join(hostRoot, 'Cargo.toml'), 'utf8')) as {
    package: { name: string };
    lib: { name?: string; 'crate-type': string[] };
  };
}

describe('Windows remote desktop packaging', () => {
  it('keeps the default binary and cdylib from linking to the same MSVC PDB', async () => {
    const manifest = await readHostManifest();
    // Cargo infers the library name from the package when no name is given.
    // MSVC PDB filenames normalize hyphens even though the EXE keeps them.
    const binaryStem = manifest.package.name.replaceAll('-', '_').toLowerCase();
    const libraryStem = (manifest.lib.name ?? manifest.package.name)
      .replaceAll('-', '_')
      .toLowerCase();

    expect(manifest.lib['crate-type']).toContain('cdylib');
    expect(libraryStem).not.toBe(binaryStem);
  });

  it('stages the renamed Cargo DLL under the existing runtime and security-check filename', async () => {
    const [manifest, forge, loader, security] = await Promise.all([
      readHostManifest(),
      readFile(path.join(desktopRoot, 'forge.config.ts'), 'utf8'),
      readFile(path.resolve(import.meta.dirname, '../windowsHost.ts'), 'utf8'),
      readFile(path.join(hostRoot, 'src', 'security.rs'), 'utf8'),
    ]);

    expect(manifest.package.name).toBe('cindy-windows-desktop-host');
    expect(forge).toContain(
      `fs.copyFileSync(path.join(output, '${manifest.lib.name}.dll'), ` +
        'path.join(destDir, `${name}.node`))',
    );
    expect(loader).toContain("'cindy-windows-desktop-host.node'");
    expect(security).toContain('with_file_name("cindy-windows-desktop-host.node")');
  });
});
