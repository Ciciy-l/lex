import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { app } from 'electron';
import type { HarnessKind, HarnessSource } from '../../shared/harnessSettings.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import { harnessExecutable } from './harness-releases.js';

export interface HarnessSelection {
  version: string;
  source: HarnessSource;
  directory: string;
  executableSha256: string;
  executableSize: number;
}
export function harnessRoot(kind: HarnessKind): string {
  return path.join(app.getPath('userData'), 'harness-runtimes', kind);
}
export function hashRuntimeFile(file: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const size = fs.readSync(fd, buffer);
      if (!size) break;
      hash.update(buffer.subarray(0, size));
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}
export function selectedBinary(kind: HarnessKind, selection: HarnessSelection): string {
  if (!/^[0-9]+[.][0-9]+[.][0-9]+-[a-f0-9-]{36}$/.test(selection.directory))
    throw new Error('INVALID_RUNTIME_DIRECTORY');
  if (!selection.directory.startsWith(selection.version + '-'))
    throw new Error('INVALID_RUNTIME_DIRECTORY');
  return path.join(harnessRoot(kind), selection.directory, harnessExecutable(kind));
}
export function readHarnessSelection(kind: HarnessKind): HarnessSelection | null {
  try {
    const text = readAtomicFileSync(path.join(harnessRoot(kind), 'selected.json'));
    if (!text) return null;
    const raw = JSON.parse(text) as HarnessSelection;
    if (
      !/^[0-9]+[.][0-9]+[.][0-9]+$/.test(raw.version) ||
      !['upstream', 'baseline'].includes(raw.source) ||
      !/^[a-f0-9]{64}$/.test(raw.executableSha256) ||
      !Number.isSafeInteger(raw.executableSize) ||
      raw.executableSize <= 0
    )
      return null;
    selectedBinary(kind, raw);
    return raw;
  } catch {
    return null;
  }
}
function canonicalIdentity(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
const active = new Map<HarnessKind, HarnessSelection | null>();
const checkedIdentity = new Map<string, string>();
/** Frozen per process: GUI installations only change the next-launch selection. */
export function activeHarnessSelection(kind: HarnessKind): HarnessSelection | null {
  if (!active.has(kind)) active.set(kind, readHarnessSelection(kind));
  const selection = active.get(kind) ?? null;
  if (!selection) return null;
  try {
    const binary = selectedBinary(kind, selection);
    const stat = fs.lstatSync(binary);
    const directory = path.join(harnessRoot(kind), selection.directory);
    // The host owns userData (whose ancestors may legitimately be symlinks, e.g. macOS /var).
    // No component below that anchor may redirect the selected distribution.
    const expectedDirectory = path.join(
      fs.realpathSync(app.getPath('userData')),
      'harness-runtimes',
      kind,
      selection.directory,
    );
    const expectedBinary = path.join(expectedDirectory, harnessExecutable(kind));
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.size !== selection.executableSize ||
      canonicalIdentity(fs.realpathSync(directory)) !== canonicalIdentity(expectedDirectory) ||
      canonicalIdentity(fs.realpathSync(binary)) !== canonicalIdentity(expectedBinary)
    )
      return null;
    const identity = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
    if (checkedIdentity.get(binary) !== identity) {
      if (hashRuntimeFile(binary) !== selection.executableSha256) return null;
      checkedIdentity.set(binary, identity);
    }
    fs.accessSync(binary, fs.constants.X_OK);
    return selection;
  } catch {
    return null;
  }
}
export function activeHarnessPath(kind: HarnessKind): string | null {
  const selection = activeHarnessSelection(kind);
  return selection ? selectedBinary(kind, selection) : null;
}
export function persistHarnessSelection(kind: HarnessKind, selection: HarnessSelection): void {
  atomicWriteFileSync(path.join(harnessRoot(kind), 'selected.json'), JSON.stringify(selection));
}
/** Reserved for the already-authorized native Pi update command, never GUI installs. */
export function activateNativeHarnessSelection(kind: 'pi', selection: HarnessSelection): void {
  active.set(kind, selection);
}
