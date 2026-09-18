/**
 * OMP filesystem customization scanner.
 *
 * OMP uses the shared ~/.agents/skills user root.  Its native project
 * discovery additionally recognizes .omp/.agents/.claude/.codex/.github
 * Skill folders from the current working directory up to the nearest Git
 * boundary.  This is an advisory SkillHub/palette view; the live OMP command
 * catalog remains the authority for what loaded in a concrete process.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  AgentCustomization,
  ListCustomizationsOptions,
  ListCustomizationsResult,
} from '../../types/customizations.js';
import { isSkillDisabled } from '../shared/skill-activation.js';
import { scanCustomizationSources, type SourceDef } from '../shared/customization-scanner.js';

const PROJECT_SKILL_DIRECTORIES: readonly (readonly string[])[] = [
  ['.omp', 'skills'],
  ['.agents', 'skills'],
  ['.claude', 'skills'],
  ['.codex', 'skills'],
  ['.github', 'skills'],
];

function canonicalDirectory(dir: string): string {
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) return resolved;
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isExistingDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function hasGitMarker(dir: string): boolean {
  try {
    const marker = fs.statSync(path.join(dir, '.git'));
    return marker.isDirectory() || marker.isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // An inaccessible marker still forms a conservative discovery boundary.
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}

function findNearestGitRoot(workingDir: string): string | null {
  let current = canonicalDirectory(workingDir);
  while (true) {
    if (hasGitMarker(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function projectAncestors(workingDir: string): string[] {
  const start = canonicalDirectory(workingDir);
  const repoRoot = findNearestGitRoot(start);
  const result: string[] = [];
  let current = start;
  while (true) {
    result.push(current);
    if (!repoRoot || current === repoRoot) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
}

/** Build the exact filesystem sources OMP can discover for local Skills. */
export function buildOmpSources(
  workingDirs: readonly string[],
  homeDir = os.homedir(),
): SourceDef[] {
  const sources: SourceDef[] = [
    { engine: 'omp', kind: 'skill', scope: 'user', dir: path.join(homeDir, '.agents', 'skills') },
  ];
  const seen = new Set<string>();

  for (const input of workingDirs) {
    if (!input || !path.isAbsolute(input) || !isExistingDirectory(input)) continue;
    const workingDir = path.resolve(input);
    const scanRoot = canonicalDirectory(input);
    const projectBoundary = findNearestGitRoot(scanRoot) ?? scanRoot;
    for (const ancestor of projectAncestors(scanRoot)) {
      for (const parts of PROJECT_SKILL_DIRECTORIES) {
        const dir = path.join(ancestor, ...parts);
        const key = `${workingDir}\0${canonicalDirectory(dir)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        sources.push({
          engine: 'omp',
          kind: 'skill',
          scope: 'repo',
          dir,
          workingDir,
          runtimeStatus: 'discovered',
          skillContainWithin: projectBoundary,
        });
      }
    }
  }
  return sources;
}

function canonicalSkillDirectory(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

function dedupeOmpItems(items: AgentCustomization[]): AgentCustomization[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = [item.scope, item.workingDir ?? '', canonicalSkillDirectory(item.absolutePath)].join('\0');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The frontmatter name is the native command identity when it is usable. */
export function ompRuntimeSkillName(item: AgentCustomization): string | undefined {
  if (item.kind !== 'skill') return undefined;
  const frontmatterName = item.frontmatter?.name;
  const candidate = typeof frontmatterName === 'string' ? frontmatterName : item.name;
  if (
    !candidate ||
    candidate.length > 512 ||
    candidate.includes('\0') ||
    Array.from(candidate).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    return undefined;
  }
  return candidate;
}

/**
 * OMP's disabledExtensions setting addresses a Skill by runtime name, not by
 * physical path.  Only disable a name when every discovered source with that
 * name is disabled in Lex, so a disabled low-priority copy cannot hide an
 * independent enabled copy.
 */
export function ompDisabledSkillNames(
  items: readonly AgentCustomization[],
  disabledPaths: readonly string[],
): string[] {
  if (disabledPaths.length === 0) return [];
  const candidates = new Map<string, AgentCustomization[]>();
  for (const item of items) {
    const name = ompRuntimeSkillName(item);
    if (!name) continue;
    const matches = candidates.get(name);
    if (matches) matches.push(item);
    else candidates.set(name, [item]);
  }
  return [...candidates.entries()]
    .filter(([, sources]) => sources.every((item) => isSkillDisabled(item.absolutePath, disabledPaths)))
    .map(([name]) => name)
    .sort((left, right) => left.localeCompare(right));
}

export async function scanOmpCustomizations(
  opts: ListCustomizationsOptions,
): Promise<ListCustomizationsResult> {
  if (opts.kinds && opts.kinds.length > 0 && !opts.kinds.includes('skill')) {
    return { items: [], errors: [] };
  }
  const result = scanCustomizationSources(buildOmpSources(opts.workingDirs ?? []), null);
  result.items = dedupeOmpItems(result.items);
  result.items.sort((left, right) => {
    if (left.scope !== right.scope) return left.scope.localeCompare(right.scope);
    if (left.name !== right.name) return left.name.localeCompare(right.name);
    return left.absolutePath.localeCompare(right.absolutePath);
  });
  return result;
}
