import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { projectOmpGlobalSkills } from './global-skills.js';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omp-global-skills-'));
  roots.push(root);
  return root;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('projectOmpGlobalSkills', () => {
  it('leaves a managed runtime untouched when the shared source does not exist', async () => {
    const root = await temporaryRoot();
    const targetRoot = path.join(root, 'runtime', '.agents', 'skills');

    await expect(projectOmpGlobalSkills({
      sourceRoot: path.join(root, 'missing'),
      targetRoot,
    })).resolves.toEqual({ status: 'missing', changed: false });
    await expect(exists(targetRoot)).resolves.toBe(false);
  });

  it('projects the shared root once and keeps its own managed link on later starts', async () => {
    const root = await temporaryRoot();
    const sourceRoot = path.join(root, 'shared', 'skills');
    const targetRoot = path.join(root, 'runtime', '.agents', 'skills');
    await mkdir(path.join(sourceRoot, 'example'), { recursive: true });
    await writeFile(path.join(sourceRoot, 'example', 'SKILL.md'), '# Example\n');

    await expect(projectOmpGlobalSkills({ sourceRoot, targetRoot })).resolves.toMatchObject({
      status: 'linked',
      changed: true,
    });
    expect(path.relative(await realpath(sourceRoot), await realpath(targetRoot))).toBe('');

    await expect(projectOmpGlobalSkills({ sourceRoot, targetRoot })).resolves.toEqual({
      status: 'kept',
      changed: false,
    });
  });

  it('does not replace an existing runtime Skills directory', async () => {
    const root = await temporaryRoot();
    const sourceRoot = path.join(root, 'shared', 'skills');
    const targetRoot = path.join(root, 'runtime', '.agents', 'skills');
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(targetRoot, { recursive: true });
    await writeFile(path.join(targetRoot, 'keep.txt'), 'user-managed');

    await expect(projectOmpGlobalSkills({ sourceRoot, targetRoot })).resolves.toMatchObject({
      status: 'conflict',
      changed: false,
    });
    await expect(readFile(path.join(targetRoot, 'keep.txt'), 'utf8')).resolves.toBe('user-managed');
  });

  it('refuses source and target layouts that would create a recursive Skill scan', async () => {
    const root = await temporaryRoot();
    const sourceRoot = path.join(root, 'shared', 'skills');
    const targetRoot = path.join(sourceRoot, 'nested-runtime', '.agents', 'skills');
    await mkdir(sourceRoot, { recursive: true });

    await expect(projectOmpGlobalSkills({ sourceRoot, targetRoot })).resolves.toMatchObject({
      status: 'skipped',
      changed: false,
    });
    await expect(exists(targetRoot)).resolves.toBe(false);
  });

  it.skipIf(process.platform !== 'win32')(
    'also detects a recursive layout when the source is expressed as an extended Win32 path',
    async () => {
      const root = await temporaryRoot();
      const sourceRoot = path.join(root, 'shared', 'skills');
      const targetRoot = path.join(sourceRoot, 'nested-runtime', '.agents', 'skills');
      await mkdir(sourceRoot, { recursive: true });

      await expect(projectOmpGlobalSkills({
        sourceRoot: `\\\\?\\${sourceRoot}`,
        targetRoot,
      })).resolves.toMatchObject({
        status: 'skipped',
        changed: false,
      });
      await expect(exists(targetRoot)).resolves.toBe(false);
    },
  );

  it('rejects malformed host paths before attempting a filesystem mutation', async () => {
    const root = await temporaryRoot();
    const targetRoot = path.join(root, 'runtime', '.agents', 'skills');

    await expect(projectOmpGlobalSkills({ sourceRoot: '', targetRoot })).resolves.toMatchObject({
      status: 'skipped',
      changed: false,
    });
    await expect(projectOmpGlobalSkills({
      sourceRoot: path.join(root, 'source'),
      targetRoot: 'relative-target',
    })).resolves.toMatchObject({
      status: 'error',
      changed: false,
    });
  });
});
