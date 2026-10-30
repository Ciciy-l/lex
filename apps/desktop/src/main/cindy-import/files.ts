import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { app } from 'electron';
import type { SessionRow } from '../session-share/sessionShareExport';
import type { CindySource } from './source';
import { copyStableFile, importError, inside, localPath } from './snapshot';

export interface WorkspaceCopy { session: SessionRow; staged: string | null; project: string | null; needsDirectory: boolean }
export interface AttachmentCopy { original: string; staged: string | null; name: string }
export function ownedWorkspaceRoots(source: CindySource): string[] {
  return [path.join(source.origin.root, 'dialogues'), path.join(source.origin.root, 'owners', createHash('sha256').update(source.origin.owner).digest('hex').slice(0, 20), 'dialogues')];
}
async function externalProjectDirectory(source: CindySource, directory: string | null): Promise<string | null> {
  if (!directory || !localPath(directory) || inside(source.origin.root, directory)) return null;
  const canonical = await fs.realpath(directory).catch(() => null);
  const targetRoot = await fs.realpath(app.getPath('userData')).catch(() => path.resolve(app.getPath('userData')));
  if (!canonical || !localPath(canonical) || inside(source.origin.root, canonical) || inside(targetRoot, canonical)) return null;
  return (await fs.stat(canonical).catch(() => null))?.isDirectory() ? canonical : null;
}
export async function copyTree(
  root: string,
  destination: string,
  check: () => void,
  missing: (name: string) => void,
  reserve?: (bytes: number) => () => void,
  observe?: (file: string, stat: Stats) => void,
): Promise<void> {
  let files = 0; let bytes = 0;
  const realRoot = await fs.realpath(root);
  if (realRoot !== path.resolve(root)) throw importError('unsafePath');
  const visit = async (dir: string, target: string, depth: number): Promise<void> => {
    check();
    if (depth > 32) throw importError('tooLarge');
    const dirStat = await fs.lstat(dir);
    if (!dirStat.isDirectory() || !inside(realRoot, await fs.realpath(dir))) throw importError('unsafePath');
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    const before = await fs.stat(dir);
    observe?.(dir, before);
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      check();
      const file = path.join(dir, entry.name);
      const dest = path.join(target, entry.name);
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) { missing(path.relative(root, file)); continue; }
      if (entry.isDirectory()) await visit(file, dest, depth + 1);
      else {
        const stat = await fs.lstat(file);
        bytes += stat.size;
        if (++files > 50000 || bytes > 2 * 1024 ** 3) throw importError('tooLarge');
        const release = reserve?.(stat.size);
        try {
          const available = await fs.statfs(target);
          if (available.bavail * available.bsize < stat.size + 64 * 1024 * 1024) throw importError('diskFull');
          await copyStableFile(root, file, dest);
          observe?.(file, stat);
        } catch (error) {
          await fs.rm(dest, { force: true }).catch(() => undefined);
          release?.();
          if (['ENOENT', 'EACCES', 'EPERM', 'unsafePath'].includes((error as { code?: string }).code ?? '')) { missing(path.relative(root, file)); continue; }
          throw error;
        }
      }
    }
    const after = await fs.stat(dir);
    if (before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) throw importError('sourceChanged');
  };
  await visit(root, destination, 0);
}
export async function prepareWorkspace(source: CindySource, session: SessionRow): Promise<WorkspaceCopy> {
  const cwd = session.workingDir;
  const owned = cwd && localPath(cwd) && ownedWorkspaceRoots(source).some((root) => inside(root, cwd));
  if (owned) {
    const staged = path.join(source.staging, randomUUID());
    const stat = await fs.lstat(cwd).catch(() => null);
    if (stat?.isDirectory()) {
      await copyTree(cwd, staged, source.assertStillValid, (name) => { source.issues.add('workspaceMissing'); source.missingFiles.add(name); }, source.reserveStaging.bind(source), source.observeFile);
      return { session, staged, project: null, needsDirectory: false };
    }
    source.issues.add('workspaceMissing');
  }
  if (session.workspaceKind === 'dialogue' && (!cwd || owned || inside(source.origin.root, cwd))) {
    return { session, staged: null, project: null, needsDirectory: false };
  }
  const project = await externalProjectDirectory(source, cwd);
  return { session, staged: null, project, needsDirectory: project === null };
}
/** Only persisted user files[] grant copy intent. Text/tool-result absolute paths do not. */
export async function prepareAttachments(source: CindySource, members: SessionRow[]): Promise<AttachmentCopy[]> {
  const copies = new Map<string, AttachmentCopy>();
  for (const session of members) {
    const roots = [path.join(source.origin.root, 'cc-agent', 'images'), path.join(source.origin.root, 'cc-agent', 'shared-media'), ...ownedWorkspaceRoots(source)];
    if (session.workingDir && await externalProjectDirectory(source, session.workingDir)) roots.push(session.workingDir);
    for (const message of await source.readMessages(session.id, session.clearedAt)) {
      if (message.role !== 'user') continue;
      let value;
      try { value = JSON.parse(message.content); } catch { continue; }
      if (!Array.isArray(value?.files)) continue;
      for (const file of value.files) {
        if (!file || typeof file.path !== 'string' || !file.path || copies.has(file.path)) continue;
        const original = file.path;
        // Protocol media are already handled by the shared media importer.
        if (/^(?:cindy-media|xdt-image|xdt-video|xdt-audio|xdt-model|xdt-file):/.test(original)) continue;
        const name = typeof file.name === 'string' ? file.name : path.basename(original);
        let staged: string | null = null;
        try {
          const root = roots.find((r) => localPath(original) && inside(r, original));
          if (!root) throw importError('unsafePath');
          staged = await source.stage(root, original);
        } catch (error) {
          if (!['ENOENT', 'EACCES', 'EPERM', 'unsafePath'].includes((error as { code?: string }).code ?? '')) throw error;
          source.issues.add('attachmentMissing'); source.missingFiles.add(name);
        }
        copies.set(original, { original, staged, name });
      }
    }
  }
  return [...copies.values()];
}
export function rewriteAttachments(content: string, paths: ReadonlyMap<string, string>): string {
  let value;
  try { value = JSON.parse(content); } catch { return content; }
  if (!Array.isArray(value?.files)) return content;
  for (const file of value.files) {
    if (file && typeof file.path === 'string' && paths.has(file.path)) {
      file.path = paths.get(file.path);
      delete file.originalPath;
    }
  }
  return JSON.stringify(value);
}
