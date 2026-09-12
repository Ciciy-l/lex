import fs from 'node:fs';
import path from 'node:path';

/** Main-owned scan snapshot. Renderer never chooses the physical deletion target. */
export interface LocalSkillTarget {
  sourcePath: string;
  operationPath: string;
  linkOnly: boolean;
  identity: string;
  aliases: string[];
}

const standaloneSkillSuffix = /\/(?:\.(?:claude|agents|codex|pi)\/skills|\.pi\/agent\/skills|(?:codex-home|pi-agent-home)\/skills)\/[^/.][^/]*$/i;

function isStandaloneSkillPath(value: string): boolean {
  const normalized = path.resolve(value).replace(/\\/g, '/');
  return standaloneSkillSuffix.test(normalized);
}

function isDirectSkillEntry(value: string): boolean {
  let current = path.resolve(value);
  const suffix = current.replace(/\\/g, '/').match(standaloneSkillSuffix)?.[0];
  if (!suffix) return false;
  // Check the entry, discovery root and engine config directories. The owner
  // prefix may itself be a tracked project alias or an OS path such as /var.
  const discoverySegmentCount = suffix.split('/').filter(Boolean).length;
  for (let index = 0; index < discoverySegmentCount; index += 1) {
    if (fs.lstatSync(current).isSymbolicLink()) return false;
    current = path.dirname(current);
  }
  return true;
}

function targetIdentity(operationPath: string): string {
  // Windows NTFS file IDs routinely exceed Number.MAX_SAFE_INTEGER. Reading
  // them as numbers can erase the low bits and make a replacement directory
  // compare equal to the confirmation snapshot, so keep the exact BigInt
  // representation until it is serialized into the opaque identity token.
  const entry = fs.lstatSync(operationPath, { bigint: true });
  const source = fs.realpathSync.native(operationPath);
  const physical = fs.statSync(source, { bigint: true });
  return JSON.stringify([
    source,
    entry.dev.toString(),
    entry.ino.toString(),
    physical.dev.toString(),
    physical.ino.toString(),
  ]);
}

/** Ownership comes from Host-managed roots, never a link name or a directory-name heuristic. */
export function isPluginManagedSkillPath(source: string, managedRoots: readonly string[]): boolean {
  const canonical = (value: string) => {
    let resolved = path.resolve(value);
    try { resolved = fs.realpathSync.native(resolved); } catch { /* Missing roots have no live targets. */ }
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const target = canonical(source);
  return managedRoots.some((root) => {
    const relative = path.relative(canonical(root), target);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });
}

/** Only standalone Skill entities may be trashed; never an enclosing package or discovery root. */
export function inspectLocalSkillTarget(source: string, discoveryPaths: readonly string[], managedRoots: readonly string[] = []): LocalSkillTarget | null {
  try {
    const sourcePath = fs.realpathSync.native(source);
    if (isPluginManagedSkillPath(sourcePath, managedRoots)) return null;
    const stat = fs.statSync(sourcePath);
    if (stat.isDirectory()) {
      if (!['SKILL.md', 'skill.md'].some((name) => fs.statSync(path.join(sourcePath, name), { throwIfNoEntry: false })?.isFile())) return null;
    } else if (!stat.isFile() || !sourcePath.toLowerCase().endsWith('.md')) return null;
    const aliases = [...new Set(discoveryPaths.map((value) => path.resolve(value)))].filter((value) => {
      try { return isStandaloneSkillPath(value) && fs.realpathSync.native(value) === sourcePath; }
      catch { return false; }
    });
    let operationPath = sourcePath;
    let linkOnly = false;
    const hasDirectEntry = aliases.some(isDirectSkillEntry);
    if (!isStandaloneSkillPath(sourcePath) || !hasDirectEntry) {
      // A link into an external checkout is an import reference, not ownership of that checkout.
      // The checkout's own directory layout does not establish local ownership.
      const externalLink = aliases.find((value) => fs.lstatSync(value).isSymbolicLink());
      if (!externalLink) return null;
      operationPath = externalLink;
      linkOnly = true;
    }
    return { sourcePath, operationPath, linkOnly, identity: targetIdentity(operationPath), aliases };
  } catch { return null; }
}

export function isLocalSkillTargetCurrent(target: LocalSkillTarget): boolean {
  try { return targetIdentity(target.operationPath) === target.identity; }
  catch { return false; }
}
