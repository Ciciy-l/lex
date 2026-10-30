import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { importError, inside, localPath } from './snapshot';
import type { CindyImportSource } from '../../shared/cindyImport';

export interface Source extends CindyImportSource { root: string; file: string; owner: string; key: string }
const execute = promisify(execFile);
export const OFFICIAL_ROOTS = ['Cindy', 'CindyGlobal', 'xdt-maker'];
export async function discoverSources(roots: string[], lexRoot: string): Promise<Source[]> {
  const excluded = await fs.realpath(lexRoot);
  const result: Source[] = [];
  const seen = new Set<string>();
  for (const candidate of roots) {
    if (!localPath(candidate)) continue;
    const root = await fs.realpath(candidate).catch(() => null);
    if (!root || !localPath(root) || inside(excluded, root) || seen.has(root) || root.split(path.sep).some((part) => /^(?:Lex(?:Global|Dev)?(?:-dev.*)?|CindyDev|Cindy(?:Global)?-dev.*|xdt-maker-dev.*|\.cindy-worktrees|\.xdt-worktrees)$/i.test(part))) continue;
    seen.add(root);
    const entries = (await fs.readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    let accountIndex = 0;
    for (const entry of entries) {
      const match = /^(?:cindy|xdt-maker)-([a-zA-Z0-9_-]+)\.db$/.exec(entry.name);
      if (!entry.isFile() || !match || /(?:backup|migration|tombstone)/i.test(entry.name)) continue;
      const owner = match[1];
      // Migration keeps the legacy DB. Prefer the current copy for the same source account.
      if (entry.name.startsWith('xdt-maker-') && entries.some((other) => other.isFile() && other.name === 'cindy-' + owner + '.db')) continue;
      accountIndex += 1;
      result.push({ id: randomUUID(), root, file: path.join(root, entry.name), owner, accountIndex,
        key: createHash('sha256').update(root).update('\0').update(entry.name).digest('hex'),
        label: path.basename(root), location: root });
    }
  }
  return result;
}
export function recognizedCindyProcess(name: string): boolean {
  const executable = name.replaceAll(String.fromCharCode(92), '/').split('/').pop()?.toLowerCase();
  return ['cindy', 'cindyglobal', 'xdt-maker', 'cindy.exe', 'cindyglobal.exe', 'xdt-maker.exe'].includes(executable ?? '');
}
function profileHolderProcess(name: string): boolean {
  const executable = name.replaceAll(String.fromCharCode(92), '/').split('/').pop()?.toLowerCase();
  return recognizedCindyProcess(name) || ['electron', 'electron.exe', 'cindydev', 'cindydev.exe'].includes(executable ?? '');
}
async function readProcessName(pid: number): Promise<string | null> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-Process -Id ' + String(pid) + ' -ErrorAction Stop | Select-Object -ExpandProperty ProcessName'],
      { timeout: 5_000, maxBuffer: 4096, windowsHide: true });
      return stdout.trim() || null;
    }
    const { stdout } = await execute('/bin/ps', ['-p', String(pid), '-o', 'comm='], { timeout: 5_000, maxBuffer: 4096 });
    return stdout.trim() || null;
  } catch { throw importError('sourceUnreadable'); }
}
/** Only executable names are inspected; command-line arguments may contain secrets. */
export async function assertSourceStopped(root: string): Promise<void> {
  const records = await fs.readdir(path.join(root, '.dev-instances')).catch((e) => {
    if (e.code === 'ENOENT') return []; throw importError('sourceUnreadable');
  });
  for (const name of records) {
    const match = /^(\d+)\.json(?:\.bak)?$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue; }
    const command = await readProcessName(pid);
    if (command && profileHolderProcess(command)) throw importError('sourceRunning');
  }
  const lock = await fs.readlink(path.join(root, 'SingletonLock')).catch((e) => {
    if (e.code === 'ENOENT' || e.code === 'EINVAL') return ''; throw importError('sourceUnreadable');
  });
  const pid = /-(\d+)$/.exec(lock)?.[1];
  if (pid) {
    const lockPid = Number(pid);
    let lockAlive = true;
    try { process.kill(lockPid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') lockAlive = false; else throw importError('sourceUnreadable'); }
    if (lockAlive) {
      const command = await readProcessName(lockPid);
      if (command && profileHolderProcess(command)) throw importError('sourceRunning');
    }
  }
  let names: string;
  try {
    names = process.platform === 'win32'
      ? (await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          "Get-Process | Where-Object { $_.ProcessName -in @('Cindy','CindyGlobal','xdt-maker') } | Select-Object -ExpandProperty ProcessName"],
        { timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true })).stdout
      : (await execute('/bin/ps', ['-axo', 'comm='], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })).stdout;
  } catch { throw importError('sourceUnreadable'); }
  if (names.split(/\r?\n/).some((name) => recognizedCindyProcess(name.trim()))) throw importError('sourceRunning');
}

export async function databaseStamp(file: string): Promise<string> {
  return JSON.stringify(await Promise.all(['', '-wal', '-shm', '-journal'].map(async (suffix) => {
    const s = await fs.lstat(file + suffix).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
    if (s && !s.isFile()) throw importError('unsafePath');
    return s ? [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs] : null;
  })));
}
