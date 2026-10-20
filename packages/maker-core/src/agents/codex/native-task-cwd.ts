import path from 'node:path';

/** Native relative paths are relative to the captured PTY/task cwd, never this process. */
export function isCodexNativeTaskCwd(cwd: string, requested: unknown): boolean {
  return typeof requested === 'string' && requested.length > 0 && !requested.includes('\0')
    && path.relative(cwd, path.resolve(cwd, requested)) === '';
}
