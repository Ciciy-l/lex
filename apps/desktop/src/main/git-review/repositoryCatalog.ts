import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getRemoteFileBrowser } from '../file-browser/remote-deps.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { runGit } from './gitRunner.js';
import type { ReviewScope } from './types.js';
import type { ReviewRepository, ReviewRepositoryList } from '../../shared/gitRepositories.js';

const SKIP = new Set([
  '.git',
  'node_modules',
  '.pnpm',
  '.yarn',
  '.venv',
  'venv',
  'dist',
  'build',
  'target',
  '.next',
  'out',
]);
const MAX_DEPTH = 5;
const MAX_DIRECTORIES = 1000;
const MAX_REPOSITORIES = 64;
const SCAN_MS = 10_000;
const catalogs = new Map<string, { at: number; value: ReviewRepositoryList; manual: string[] }>();
const pending = new Map<string, Promise<ReviewRepositoryList>>();

function context(scope: ReviewScope, hostId: string | null) {
  const paths = hostId ? path.posix : path;
  const workspace = hostId
    ? (scope.workingDir ?? scope.workdir)
    : scope.source === 'worktree'
      ? scope.workdir
      : (scope.workingDir ?? scope.workdir ?? scope.worktreePath);
  const root = workspace ? paths.resolve(workspace) : null;
  return { paths, root, key: JSON.stringify([scope.sessionId, hostId, root, scope.repoRoot]) };
}

function inside(paths: typeof path, root: string, target: string): boolean {
  const rel = paths.relative(root, target);
  return !paths.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${paths.sep}`);
}

async function validateDirectory(
  root: string,
  relative: string,
  hostId: string | null,
): Promise<string> {
  const paths = hostId ? path.posix : path;
  if (relative.includes('\0') || paths.isAbsolute(relative) || relative.includes('\\'))
    throwIpcError('INVALID_PARAMS', 'Repository must be inside the workspace');
  const directory = paths.resolve(root, relative);
  if (!inside(paths, root, directory))
    throwIpcError('INVALID_PARAMS', 'Repository must be inside the workspace');
  if (hostId) {
    // stat enforces realpath containment on the SSH file service.
    await getRemoteFileBrowser().request(hostId, 'stat', {
      workdir: root,
      relPath: paths.relative(root, directory),
    });
  } else {
    const [realRoot, realDirectory] = await Promise.all([
      fs.realpath(root),
      fs.realpath(directory),
    ]);
    if (!inside(path, realRoot, realDirectory))
      throwIpcError('INVALID_PARAMS', 'Repository escapes the workspace');
  }
  return directory;
}

export async function listReviewRepositories(
  scope: ReviewScope,
  hostId: string | null,
  options: { refresh?: boolean; relativePath?: string } = {},
  git = runGit,
): Promise<ReviewRepositoryList> {
  const { paths, root, key } = context(scope, hostId);
  if (!root)
    return { repositories: [], workspace: null, defaultRepositoryId: null, partial: false };
  const previous = catalogs.get(key);
  if (
    !options.refresh &&
    options.relativePath === undefined &&
    previous &&
    Date.now() - previous.at < 60_000
  )
    return previous.value;
  const active = pending.get(key);
  if (active) {
    await active;
    return listReviewRepositories(scope, hostId, { ...options, refresh: false }, git);
  }
  const scan = async (): Promise<ReviewRepositoryList> => {
    const manual = [...(previous?.manual ?? [])];
    if (options.relativePath !== undefined) {
      await validateDirectory(root, options.relativePath, hostId);
      if (!manual.includes(options.relativePath)) {
        if (manual.length >= MAX_REPOSITORIES)
          throwIpcError('PRECONDITION_FAILED', 'Too many manually selected repositories');
        manual.push(options.relativePath);
      }
    }
    const found = new Map<string, ReviewRepository>();
    const add = (candidate: string) => {
      const normalized = paths.normalize(candidate);
      const identity =
        !hostId && process.platform === 'win32' ? normalized.toLowerCase() : normalized;
      const id = createHash('sha256').update(`${key}\0${identity}`).digest('hex');
      found.set(identity, {
        id,
        root: normalized,
        relativePath: paths.relative(root, normalized).split(paths.sep).join('/') || '.',
        name: paths.basename(normalized) || normalized,
      });
      return id;
    };
    const defaultRepositoryId = scope.repoRoot ? add(scope.repoRoot) : null;
    const probe = async (directory: string) => {
      const { stdout } = await git(['rev-parse', '--show-toplevel'], {
        cwd: directory,
        timeoutMs: 5000,
      });
      const repo = paths.normalize(stdout.trim());
      if (!paths.isAbsolute(repo) || !inside(paths, root, repo)) return;
      add(repo);
    };
    for (const rel of manual) {
      try {
        const before = found.size;
        await probe(await validateDirectory(root, rel, hostId));
        if (
          rel === options.relativePath &&
          found.size === before &&
          ![...found.values()].some((repo) => repo.root === paths.resolve(root, rel))
        )
          throwIpcError(
            'PRECONDITION_FAILED',
            'No repository found at the requested workspace path',
          );
      } catch (error) {
        if (rel === options.relativePath) throw error;
      }
    }
    const queue = [{ directory: root, depth: 0 }];
    const started = Date.now();
    let visited = 0;
    let partial = false;
    while (queue.length) {
      if (
        ++visited > MAX_DIRECTORIES ||
        found.size >= MAX_REPOSITORIES ||
        Date.now() - started >= SCAN_MS
      ) {
        partial = true;
        break;
      }
      const { directory, depth } = queue.shift()!;
      try {
        const entries = hostId
          ? (
              await getRemoteFileBrowser().request(hostId, 'listDir', {
                workdir: root,
                relPath: paths.relative(root, directory),
                includeIgnored: true,
                hideMetaFiles: false,
              })
            ).entries.map((e) => ({ name: e.name, directory: e.type === 'directory' }))
          : (await fs.readdir(directory, { withFileTypes: true }))
              .filter((e) => !e.isSymbolicLink())
              .map((e) => ({ name: e.name, directory: e.isDirectory() }));
        if (entries.length > 10000) partial = true;
        if (entries.some((e) => e.name === '.git')) await probe(directory);
        for (const entry of entries.slice(0, 10000).sort((a, b) => a.name.localeCompare(b.name))) {
          if (!entry.directory || SKIP.has(entry.name)) continue;
          if (depth >= MAX_DEPTH) {
            partial = true;
            continue;
          }
          queue.push({ directory: paths.join(directory, entry.name), depth: depth + 1 });
        }
      } catch (error) {
        if (directory === root) throw error;
        partial = true;
      }
    }
    const repositories = [...found.values()].sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath),
    );
    const value = {
      repositories,
      workspace: root,
      defaultRepositoryId: defaultRepositoryId ?? repositories[0]?.id ?? null,
      partial,
    };
    catalogs.set(key, { at: Date.now(), value, manual });
    if (catalogs.size > 100) catalogs.delete(catalogs.keys().next().value!);
    return value;
  };
  const promise = scan();
  pending.set(key, promise);
  try {
    return await promise;
  } finally {
    pending.delete(key);
  }
}

export async function resolveCatalogRepository(
  scope: ReviewScope,
  hostId: string | null,
  id: string,
  git = runGit,
): Promise<string> {
  const catalog = await listReviewRepositories(scope, hostId, {}, git);
  const repo = catalog.repositories.find((entry) => entry.id === id);
  if (!repo) throwIpcError('PRECONDITION_FAILED', 'Repository selection is no longer available');
  if (repo.root !== scope.repoRoot && catalog.workspace)
    await validateDirectory(catalog.workspace, repo.relativePath, hostId);
  const { stdout } = await git(['rev-parse', '--show-toplevel'], { cwd: repo.root });
  const paths = hostId ? path.posix : path;
  if (paths.relative(repo.root, stdout.trim()) !== '')
    throwIpcError('PRECONDITION_FAILED', 'Repository identity changed');
  return repo.root;
}
