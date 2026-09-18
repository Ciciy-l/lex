import fs from 'node:fs/promises';
import path from 'node:path';

/** Result of projecting the shared native Skill root into one managed OMP HOME. */
export type OmpGlobalSkillsProjectionStatus =
  | 'linked'
  | 'kept'
  | 'missing'
  | 'conflict'
  | 'skipped'
  | 'error';

export interface OmpGlobalSkillsProjectionResult {
  readonly status: OmpGlobalSkillsProjectionStatus;
  readonly changed: boolean;
  readonly reason?: string;
}

export interface OmpGlobalSkillsProjectionInput {
  /** Native shared Skill root (normally ~/.agents/skills), supplied by the host. */
  readonly sourceRoot?: string;
  /** One OMP runtime's managed $HOME/.agents/skills directory. */
  readonly targetRoot: string;
}

function normalizeForCompare(value: string): string {
  // `fs.realpath` on Windows is allowed to return the extended-length form
  // (`\\?\\C:\\...`), while an as-yet-uncreated target is necessarily a
  // normal lexical path.  Compare both in the same Win32 namespace; otherwise
  // `path.relative` treats them as different roots and can miss a recursive
  // source -> target projection.
  const comparable = process.platform === 'win32'
    ? value.startsWith('\\\\?\\UNC\\')
      ? `\\\\${value.slice('\\\\?\\UNC\\'.length)}`
      : value.startsWith('\\\\?\\')
        ? value.slice('\\\\?\\'.length)
        : value
    : value;
  const resolved = path.resolve(comparable);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSameOrInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function realDirectory(value: string): Promise<{ path: string | null; reason?: string }> {
  try {
    const stat = await fs.stat(value);
    if (!stat.isDirectory()) return { path: null, reason: 'source is not a directory' };
    return { path: normalizeForCompare(await fs.realpath(value)) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { path: null };
    return { path: null, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Make the shared ~/.agents/skills root visible to OMP without adopting the
 * user's OMP config or credentials.  The target is inside the session-owned
 * runtime HOME; existing user/unknown entries are never replaced.
 */
export async function projectOmpGlobalSkills(
  input: OmpGlobalSkillsProjectionInput,
): Promise<OmpGlobalSkillsProjectionResult> {
  const sourceRoot = input.sourceRoot;
  const targetRoot = input.targetRoot;
  if (
    typeof targetRoot !== 'string' ||
    !targetRoot ||
    targetRoot.includes('\0') ||
    !path.isAbsolute(targetRoot)
  ) {
    return { status: 'error', changed: false, reason: 'managed target is not an absolute path' };
  }
  if (sourceRoot === undefined) return { status: 'missing', changed: false };
  if (
    typeof sourceRoot !== 'string' ||
    !sourceRoot ||
    sourceRoot.includes('\0') ||
    !path.isAbsolute(sourceRoot)
  ) {
    return { status: 'skipped', changed: false, reason: 'source is not an absolute path' };
  }

  const source = await realDirectory(sourceRoot);
  if (!source.path) {
    return source.reason
      ? { status: 'error', changed: false, reason: source.reason }
      : { status: 'missing', changed: false };
  }
  const normalizedTarget = normalizeForCompare(targetRoot);
  // Linking a root to itself or into either side of itself creates a recursive
  // discovery tree.  Treat it as an optional-resource miss, never as a reason
  // to mutate either directory.
  if (
    isSameOrInside(source.path, normalizedTarget) ||
    isSameOrInside(normalizedTarget, source.path)
  ) {
    return { status: 'skipped', changed: false, reason: 'source would create a scan cycle' };
  }

  const target = await realDirectory(targetRoot);
  if (target.path === source.path) return { status: 'kept', changed: false };
  if (target.path !== null) {
    return { status: 'conflict', changed: false, reason: 'target already exists as a directory' };
  }
  if (target.reason) return { status: 'error', changed: false, reason: target.reason };

  try {
    const entry = await fs.lstat(targetRoot);
    return {
      status: 'conflict',
      changed: false,
      reason: entry.isSymbolicLink()
        ? 'target is a link to a different source'
        : 'target already exists and is not a directory',
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { status: 'error', changed: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  try {
    await fs.mkdir(path.dirname(targetRoot), { recursive: true });
    // Recheck after mkdir so a concurrent writer cannot be overwritten.
    try {
      await fs.lstat(targetRoot);
      return { status: 'conflict', changed: false, reason: 'target appeared during projection' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await fs.symlink(sourceRoot, targetRoot, process.platform === 'win32' ? 'junction' : 'dir');
    return { status: 'linked', changed: true };
  } catch (error) {
    return { status: 'error', changed: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
