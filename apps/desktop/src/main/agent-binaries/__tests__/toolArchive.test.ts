import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import JSZip from 'jszip';
import * as tar from 'tar';
import { extractToolArchive, safeArchiveLink, safeArchivePath } from '../toolArchive.js';

let temp: string;
let sequence = 0;
beforeAll(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'tool-archive-test-'));
});
afterAll(async () => {
  await rm(temp, { recursive: true, force: true });
});
async function fixture() {
  const root = path.join(temp, String(++sequence));
  const destination = path.join(root, 'extracted');
  await mkdir(destination, { recursive: true });
  return { root, destination, archive: path.join(root, 'archive') };
}
const zipArtifact = { format: 'zip' as const, executable: 'publisher/bin/tool.exe' };
const tarArtifact = { format: 'tar.gz' as const, executable: 'publisher/bin/node' };
describe('bounded publisher archive extraction', () => {
  it.each(['../escape', '/absolute', 'C:/drive', 'a\\escape', 'a/../../escape', 'a/./file'])(
    'rejects archive path %s on every host',
    (name) => {
      expect(() => safeArchivePath(name)).toThrow();
    },
  );
  it('accepts only links that stay inside the extraction root', () => {
    expect(() => safeArchiveLink('python/bin/python3', 'python3.13', false)).not.toThrow();
    expect(() =>
      safeArchiveLink('python/bin/libpython', '../lib/libpython.so', false),
    ).not.toThrow();
    expect(() => safeArchiveLink('python/bin/python3', '../../../escape', false)).toThrow();
    expect(() => safeArchiveLink('python/bin/python3', '/usr/bin/python3', false)).toThrow();
    expect(() => safeArchiveLink('python/bin/python3', '../../escape', true)).toThrow();
  });
  it('extracts ZIP files with publisher directories intact', async () => {
    const f = await fixture();
    const zip = new JSZip().file('publisher/bin/tool.exe', 'tool');
    await writeFile(f.archive, await zip.generateAsync({ type: 'nodebuffer' }));
    await extractToolArchive(f.archive, f.destination, zipArtifact, new AbortController().signal);
    expect(await readFile(path.join(f.destination, 'publisher', 'bin', 'tool.exe'), 'utf8')).toBe(
      'tool',
    );
  });
  it('rejects a ZIP traversal even after JSZip normalizes the visible name', async () => {
    const f = await fixture();
    await writeFile(
      f.archive,
      await new JSZip()
        .file('../escaped', 'unsafe', { createFolders: false })
        .generateAsync({ type: 'nodebuffer' }),
    );
    await expect(
      extractToolArchive(f.archive, f.destination, zipArtifact, new AbortController().signal),
    ).rejects.toThrow('Unsafe');
    expect(await readdir(f.destination)).toEqual([]);
    expect(await readdir(f.root)).not.toContain('escaped');
  });
  it('preflights tar paths and links before writing any entry', async () => {
    for (const entry of [
      { path: '../escaped', type: 'File' as const, size: 0 },
      {
        path: 'python/bin/link',
        type: 'SymbolicLink' as const,
        linkpath: '../../../escaped',
        size: 0,
      },
    ]) {
      const f = await fixture();
      const header = new tar.Header(entry);
      header.encode();
      await writeFile(f.archive, Buffer.concat([header.block!, Buffer.alloc(1024)]));
      await expect(
        extractToolArchive(f.archive, f.destination, tarArtifact, new AbortController().signal),
      ).rejects.toThrow('Unsafe');
      expect(await readdir(f.destination)).toEqual([]);
    }
  });
  it('extracts a gzip tar and honors an already cancelled operation without writing files', async () => {
    const f = await fixture();
    const source = path.join(f.root, 'source');
    await mkdir(path.join(source, 'publisher', 'bin'), { recursive: true });
    await writeFile(path.join(source, 'publisher', 'bin', 'node'), 'node');
    await tar.c({ file: f.archive, gzip: true, cwd: source }, ['publisher']);
    const controller = new AbortController();
    controller.abort();
    await expect(
      extractToolArchive(f.archive, f.destination, tarArtifact, controller.signal),
    ).rejects.toBeDefined();
    expect(await readdir(f.destination)).toEqual([]);
    await extractToolArchive(f.archive, f.destination, tarArtifact, new AbortController().signal);
    expect(await readFile(path.join(f.destination, 'publisher', 'bin', 'node'), 'utf8')).toBe(
      'node',
    );
  });
});
