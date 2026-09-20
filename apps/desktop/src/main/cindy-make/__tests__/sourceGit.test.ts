import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeSourceGitEnvironment, parseSourceGitProgress, runSourceGit } from '../sourceGit.js';

describe('Cindy Make Git progress', () => {
  it('parses Git progress without exposing the raw line', () => {
    expect(parseSourceGitProgress('remote: Receiving objects:  42% (123/456)')).toEqual({
      stage: 'receiving',
      percent: 42,
    });
    expect(parseSourceGitProgress('Resolving deltas: 100% (9/9)')).toEqual({
      stage: 'resolving',
      percent: 100,
    });
  });

  it('ignores ordinary output and invalid percentages', () => {
    expect(parseSourceGitProgress('remote: Total 9 (delta 1)')).toBeUndefined();
    expect(parseSourceGitProgress('Receiving objects: 101%')).toBeUndefined();
  });

  it('rejects a bare Git name before a task-local executable can affect lookup', async () => {
    const worktree = await mkdtemp(path.join(os.tmpdir(), 'cindy-make-git-cwd-'));
    try {
      // On Windows, CreateProcess searches cwd before PATH for a bare command.
      // The file must be irrelevant because this runner accepts only an absolute
      // executable selected by the Make toolchain.
      await writeFile(
        path.join(worktree, process.platform === 'win32' ? 'git.exe' : 'git'),
        'not a Git executable',
      );
      await expect(
        runSourceGit('git', { PATH: '' }, ['--version'], worktree, new AbortController().signal),
      ).rejects.toMatchObject({ code: 'gitFailed' });
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'win32')(
    'runs the selected absolute executable instead of a task-local git.exe',
    async () => {
      const worktree = await mkdtemp(path.join(os.tmpdir(), 'cindy-make-git-absolute-'));
      try {
        // A copied Node executable is enough to make the historical bare
        // `spawn('git')` route observably wrong: it would receive cmd.exe's
        // arguments instead of producing this fixed output.
        await copyFile(process.execPath, path.join(worktree, 'git.exe'));
        const cmd = process.env.ComSpec;
        expect(cmd).toBeDefined();
        expect(path.isAbsolute(cmd!)).toBe(true);
        await expect(
          runSourceGit(
            cmd!,
            { SystemRoot: process.env.SystemRoot },
            ['/d', '/s', '/c', 'echo MANAGED_ABSOLUTE'],
            worktree,
            new AbortController().signal,
          ),
        ).resolves.toBe('MANAGED_ABSOLUTE');
      } finally {
        await rm(worktree, { recursive: true, force: true });
      }
    },
  );

  it('removes inherited Git repository overrides without mutating the caller environment', () => {
    const source = {
      PATH: '/managed/git',
      KEEP: 'value',
      GIT_DIR: '/redirected/repository',
      git_work_tree: '/redirected/worktree',
      GIT_CONFIG_KEY_0: 'url.bad.insteadOf',
      GIT_CONFIG_VALUE_0: 'https://github.com/makecindy/',
      GIT_SSL_NO_VERIFY: '1',
      LC_ALL: 'unexpected',
      git_terminal_prompt: '1',
    };
    const environment = makeSourceGitEnvironment(source);

    expect(environment).toMatchObject({
      PATH: '/managed/git',
      KEEP: 'value',
      LC_ALL: 'C',
      LANG: 'C',
      GIT_TERMINAL_PROMPT: '0',
    });
    expect(Object.keys(environment).map((key) => key.toUpperCase())).not.toEqual(
      expect.arrayContaining([
        'GIT_DIR',
        'GIT_WORK_TREE',
        'GIT_CONFIG_KEY_0',
        'GIT_CONFIG_VALUE_0',
        'GIT_SSL_NO_VERIFY',
      ]),
    );
    expect(source).toMatchObject({
      GIT_DIR: '/redirected/repository',
      git_work_tree: '/redirected/worktree',
      GIT_CONFIG_KEY_0: 'url.bad.insteadOf',
      GIT_CONFIG_VALUE_0: 'https://github.com/makecindy/',
      GIT_SSL_NO_VERIFY: '1',
      LC_ALL: 'unexpected',
      git_terminal_prompt: '1',
    });
  });
});
