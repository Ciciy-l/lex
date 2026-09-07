import path from 'node:path';
import { stat } from 'node:fs/promises';
import { statEntry } from '@cindy/file-browser-core';

/** Authorization is based on the Lead root; relative paths use the PTY startup cwd. */
export async function resolveTerminalFile(root: string, startupCwd: string, candidate: string): Promise<{ workdir: string; path: string; kind: 'file' | 'directory' }> {
  if (!root || !path.isAbsolute(root) || !path.isAbsolute(startupCwd) || !candidate || candidate.length > 4096 || /[\x00-\x1f]/.test(candidate) || candidate.includes('://') || candidate.startsWith('~')) throw new Error('INVALID_PATH');
  if (process.platform === 'win32' && (/^[A-Za-z]:(?![\\/])/.test(candidate) || candidate.startsWith('/'))) throw new Error('AMBIGUOUS_PATH');
  if (process.platform !== 'win32' && (/^[A-Za-z]:/.test(candidate) || candidate.includes('\\'))) throw new Error('AMBIGUOUS_PATH');
  const absolute = path.resolve(startupCwd, candidate);
  const relative = path.relative(root, absolute);
  // statEntry deliberately excludes the workspace root. It is already the
  // authoritative Lead root, so only this exact target may use a direct stat.
  if (!relative) {
    if (!(await stat(root)).isDirectory()) throw new Error('NOT_A_DIRECTORY');
    return { workdir: root, path: '', kind: 'directory' };
  }
  const entry = await statEntry(root, relative);
  return { workdir: root, path: relative.split(path.sep).join('/'), kind: entry.type };
}
