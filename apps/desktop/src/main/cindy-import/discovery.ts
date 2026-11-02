import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readDesktopProcessIdentity, isReusedDesktopInstancePid } from '../desktopProcessIdentity';
import { sourceDatabaseHolders } from './occupancy';
import { importError, inside, localPath } from './snapshot';
import type { CindyImportSource } from '../../shared/cindyImport';

export interface Source extends CindyImportSource { root: string; file: string; owner: string; key: string }
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
/** Read-only provenance under the selected profile, followed by exact file holders.
 * A globally running Cindy using another profile is not evidence of occupancy. */
export async function assertSourceStopped(root: string, file?: string): Promise<void> {
  const records = await fs.readdir(path.join(root, '.dev-instances')).catch((error) => {
    if (error.code === 'ENOENT') return []; throw importError('sourceUnreadable');
  });
  const alive = (pid: number): boolean => {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
    try { process.kill(pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw importError('sourceUnreadable'); }
  };
  for (const name of records) {
    const match = /^(\d+)\.json(?:\.bak)?$/.exec(name);
    if (!match || !alive(Number(match[1]))) continue;
    let record: { userDataDir?: string; startedAtMs?: number; processIdentity?: unknown; rootDir?: string };
    try { record = JSON.parse(await fs.readFile(path.join(root, '.dev-instances', name), 'utf8')); }
    catch { throw importError('sourceUnreadable'); }
    if (!record || typeof record !== 'object') throw importError('sourceUnreadable');
    if (typeof record.userDataDir !== 'string' || !record.userDataDir) continue; // Legacy/partial record: use exact file holders.
    const recordedRoot = await fs.realpath(record.userDataDir).catch(() => null);
    if (recordedRoot !== root) continue;
    const identity = await readDesktopProcessIdentity(Number(match[1]));
    if (!identity) { if (alive(Number(match[1]))) throw importError('sourceUnreadable'); continue; }
    if (isReusedDesktopInstancePid(record, identity)
      || (typeof record.startedAtMs === 'number' && identity.startedAtMs > record.startedAtMs + 2000)) continue;
    if (profileHolderProcess(identity.executablePath)) throw importError('sourceRunning');
  }
  // SingletonLock/WAL/SHM leftovers alone never establish a live instance.
  if (file) {
    const holders = (await sourceDatabaseHolders(file)).filter(pid => pid !== process.pid);
    for (const pid of holders) {
      const identity = await readDesktopProcessIdentity(pid);
      if (identity && recognizedCindyProcess(identity.executablePath)) throw importError('sourceRunning');
    }
    if (holders.length) throw importError('sourceBusy');
  }
}

export async function databaseStamp(file: string): Promise<string> {
  return JSON.stringify(await Promise.all(['', '-wal', '-shm', '-journal'].map(async (suffix) => {
    const s = await fs.lstat(file + suffix).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
    if (s && !s.isFile()) throw importError('unsafePath');
    return s ? [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs] : null;
  })));
}
