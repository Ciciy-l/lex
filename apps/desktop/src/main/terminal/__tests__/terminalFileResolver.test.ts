import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveTerminalFile } from '../terminalFileResolver';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
describe('terminal file authorization', () => {
  it('resolves files and directories from startup cwd but refuses missing targets and workspace escape', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'lex-terminal-file-')); temporary.push(parent);
    const root = path.join(parent, 'project'); const cwd = path.join(root, 'src');
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(cwd, 'a b.ts'), 'text'); await writeFile(path.join(parent, 'secret.txt'), 'secret');
    expect(await resolveTerminalFile(root, cwd, 'a b.ts')).toEqual({ workdir: root, path: 'src/a b.ts', kind: 'file' });
    expect(await resolveTerminalFile(root, cwd, path.join(cwd, 'a b.ts'))).toMatchObject({ path: 'src/a b.ts' });
    await expect(resolveTerminalFile(root, cwd, '../../secret.txt')).rejects.toThrow();
    await expect(resolveTerminalFile(root, cwd, 'missing.ts')).rejects.toThrow();
    expect(await resolveTerminalFile(root, cwd, '.')).toEqual({ workdir: root, path: 'src', kind: 'directory' });
    expect(await resolveTerminalFile(root, cwd, '..')).toEqual({ workdir: root, path: '', kind: 'directory' });
    await expect(resolveTerminalFile(root, cwd, '../..')).rejects.toThrow();
    await expect(resolveTerminalFile(root, cwd, 'https://example.com')).rejects.toThrow();
  });
});
