import { constants, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Worker } from 'node:worker_threads';
import { resolveBetterSqliteModuleEntry, resolveBetterSqliteNativeBinding } from '../localDb/betterSqliteFactory';

export function importError(code: string): Error { return Object.assign(new Error(code), { code }); }
export function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export function localPath(file: string): boolean {
  return path.isAbsolute(file) && !file.startsWith('\\') && !file.startsWith('//') && !file.includes(String.fromCharCode(0));
}

/** Copy one verified regular file through a single handle; never follow a link out of root. */
export async function copyStableFile(root: string, source: string, target: string): Promise<void> {
  if (!localPath(source) || !inside(root, source)) throw importError('unsafePath');
  const realRoot = await fs.realpath(root);
  const real = await fs.realpath(source);
  if (!inside(realRoot, real)) throw importError('unsafePath');
  const link = await fs.lstat(source);
  if (!link.isFile()) throw importError('unsafePath');
  const handle = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.ino !== link.ino || before.dev !== link.dev || !inside(realRoot, await fs.realpath(source))) throw importError('sourceChanged');
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await pipeline(handle.createReadStream({ autoClose: false }), createWriteStream(target, { flags: 'wx', mode: 0o600 }));
    const after = await handle.stat();
    const current = await fs.lstat(source);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || current.ino !== before.ino || current.dev !== before.dev) throw importError('sourceChanged');
  } finally { await handle.close(); }
}

/** The source is closed. Read only a private DB/WAL copy; no source-side SQLite side effects. */
export async function snapshotDatabase(root: string, file: string, destination: string): Promise<void> {
  const versions = async () => Promise.all(['', '-wal', '-shm', '-journal'].map(async (suffix) => {
    const stat = await fs.lstat(file + suffix).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
    if (stat && !stat.isFile()) throw importError('unsafePath');
    return stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : null;
  }));
  const before = await versions();
  if (!before[0]) throw importError('sourceMissing');
  const totalBytes = before.reduce((sum, value) => sum + (value ? Number(value.split(':')[2]) : 0), 0);
  if (totalBytes > 2 * 1024 ** 3) throw importError('tooLarge');
  const space = await fs.statfs(path.dirname(destination));
  if (space.bavail * space.bsize < totalBytes + 128 * 1024 * 1024) throw importError('diskFull');
  for (const [i, suffix] of ['', '-wal', '-shm', '-journal'].entries()) {
    if (before[i]) await copyStableFile(root, file + suffix, destination + suffix);
  }
  if (JSON.stringify(before) !== JSON.stringify(await versions())) throw importError('sourceChanged');
}

/** Host-internal asynchronous SELECT reader. Never expose SQL or the worker to Renderer. */
export class SnapshotReader {
  private worker: Worker;
  private serial = 0;
  private dead = false;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  constructor(file: string) {
    this.worker = new Worker(`
      const {parentPort, workerData} = require('node:worker_threads');
      const Database = require(workerData.module);
      const db = new Database(workerData.file, {readonly: true, fileMustExist: true, nativeBinding: workerData.nativeBinding});
      db.pragma('query_only = ON');
      parentPort.on('message', ({id, sql, params}) => {
        try { parentPort.postMessage({id, rows: db.prepare(sql).all(...params)}); }
        catch { parentPort.postMessage({id, error: true}); }
      });
    `, { eval: true, workerData: { file, module: resolveBetterSqliteModuleEntry() ?? 'better-sqlite3', nativeBinding: resolveBetterSqliteNativeBinding() } });
    this.worker.on('message', ({ id, rows, error }) => {
      const job = this.pending.get(id); this.pending.delete(id);
      if (error) job?.reject(importError('schemaUnsupported')); else job?.resolve(rows);
    });
    const fail = () => { this.dead = true; for (const job of this.pending.values()) job.reject(importError('sourceUnreadable')); this.pending.clear(); };
    this.worker.on('error', fail); this.worker.on('exit', fail);
  }
  query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (this.dead) return Promise.reject(importError('sourceUnreadable'));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void this.close(); }, 30_000);
      this.pending.set(id, { resolve: (rows) => { clearTimeout(timer); resolve(rows as T[]); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      this.worker.postMessage({ id, sql, params });
    });
  }
  async close(): Promise<void> { await this.worker.terminate(); }
}
