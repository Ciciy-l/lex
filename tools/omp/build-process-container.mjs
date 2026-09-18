#!/usr/bin/env node
/**
 * Build the narrow Windows OMP Job Object container beside the explicit OMP
 * development runtime. This is intentionally part of `pnpm install:omp`, not
 * postinstall or normal Desktop startup: OMP remains opt-in and no runtime
 * build tool is invoked unless a developer requested OMP.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const sourceRoot = path.join(root, 'apps', 'desktop', 'native', 'omp-process-container', 'windows');
const platformKey = `${process.platform}-${process.arch}`;
const targetForArchitecture = {
  x64: 'x86_64-pc-windows-msvc',
  arm64: 'aarch64-pc-windows-msvc',
};
const binaryName = 'cindy-omp-process-container.exe';

if (process.platform !== 'win32') {
  console.log('[omp-process-container] not required outside Windows');
  process.exit(0);
}

const target = process.env.OMP_CONTAINER_RUST_TARGET
  ?? targetForArchitecture[process.arch];
const toolchain = process.env.OMP_CONTAINER_RUST_TOOLCHAIN;
if (!target) {
  console.error(`[omp-process-container] unsupported Windows architecture: ${process.arch}`);
  process.exit(1);
}

const result = spawnSync(
  'cargo',
  [
    ...(toolchain ? [`+${toolchain}`] : []),
    'build',
    '--release',
    '--locked',
    '--target',
    target,
    '--manifest-path',
    path.join(sourceRoot, 'Cargo.toml'),
  ],
  { cwd: root, stdio: 'inherit', shell: false },
);
if (result.error || result.status !== 0) {
  const detail = result.error?.message ?? `exit code ${result.status}`;
  console.error(
    `[omp-process-container] build failed (${detail}). `
      + 'Install the Visual C++ Build Tools for the default MSVC target, then rerun pnpm install:omp.',
  );
  process.exit(result.status ?? 1);
}

const built = path.join(sourceRoot, 'target', target, 'release', binaryName);
const destinationDirectory = path.join(root, 'apps', 'omp-bin', platformKey);
const destination = path.join(destinationDirectory, binaryName);
if (!fs.existsSync(built)) {
  console.error(`[omp-process-container] cargo completed without ${built}`);
  process.exit(1);
}
fs.mkdirSync(destinationDirectory, { recursive: true });
const temporary = `${destination}.tmp`;
try {
  fs.copyFileSync(built, temporary);
  fs.renameSync(temporary, destination);
} catch (error) {
  try { fs.rmSync(temporary, { force: true }); } catch { /* no-op */ }
  console.error(
    `[omp-process-container] could not stage ${binaryName}: `
      + `${error instanceof Error ? error.message : String(error)}. Close the app and retry.`,
  );
  process.exit(1);
}
console.log(`[omp-process-container] staged ${destination}`);
