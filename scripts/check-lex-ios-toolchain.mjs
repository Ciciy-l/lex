import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Pin the stable SDK 57 toolchain available on the standard macos-26 runner.
// Xcode's marketing version, build, SDK and compiler versions are different
// identities: check the first three and record the actual Swift/Clang binaries.
export const HOSTED_IOS_TOOLCHAIN = Object.freeze({
  xcode: '26.6', build: '17F113', sdk: '26.5', cocoaPods: '1.17.0',
});

function atLeast(actual, minimum) {
  const a = actual.split('.').map(Number), b = minimum.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

export function assertIosToolchain(info, { pinned = false } = {}) {
  const xcode = /^Xcode (\d+\.\d+(?:\.\d+)?)\s*\nBuild version (\w+)\s*$/.exec(info.xcode);
  const swift = /Apple Swift version (\d+\.\d+(?:\.\d+)?)(?:\s|$)/.exec(info.swift);
  if (!xcode || !swift || !/^\d+\.\d+(?:\.\d+)?$/.test(info.sdk)
    || !/Apple clang version \d+\./.test(info.clang)) throw new Error('Cannot identify the selected Apple toolchain');
  // Expo SDK 57's official minimum. Swift 6.2 rejects RuntimeScheduler's
  // constructor ownership attributes in the Swift ClangImporter.
  if (!atLeast(xcode[1], '26.4') || !atLeast(swift[1], '6.3')) {
    throw new Error('Expo SDK 57 requires Xcode >= 26.4 and Swift >= 6.3; select a compatible DEVELOPER_DIR');
  }
  if (info.cocoaPods !== HOSTED_IOS_TOOLCHAIN.cocoaPods) throw new Error('CocoaPods 1.17.0 is required');
  if (pinned && (xcode[1] !== HOSTED_IOS_TOOLCHAIN.xcode || xcode[2] !== HOSTED_IOS_TOOLCHAIN.build
    || info.sdk !== HOSTED_IOS_TOOLCHAIN.sdk)) {
    throw new Error('Selected Xcode build/iphoneos SDK differs from the hosted iOS pin; do not fall back to another Xcode');
  }
}

function runTool(command, args, { env }) {
  console.log('+', command, ...args);
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 90_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout);
    throw result.error ?? new Error(command + ' failed (' + result.status + ') during the iOS compiler preflight');
  }
  return result.stdout.trim();
}

// Compile the installed header unmodified with the Swift importer, not just
// clang++: plain C++ compilation does not reproduce the ownership diagnostic.
// This only typechecks an arm64 iPhone consumer; no signing, Pods, simulator,
// dependency edits or writes into the native project are needed.
export function probeIosSwiftInterop({ schedulerHeader, sdkPath, env = process.env, run = runTool }) {
  const header = fs.readFileSync(schedulerHeader);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-ios-interop-'));
  try {
    fs.writeFileSync(path.join(temporary, 'RuntimeScheduler.h'), header);
    fs.writeFileSync(path.join(temporary, 'module.modulemap'),
      'module LexExpoRuntimeScheduler { header "RuntimeScheduler.h" requires cplusplus export * }\n');
    const consumer = path.join(temporary, 'use.swift');
    fs.writeFileSync(consumer, 'import LexExpoRuntimeScheduler\nfunc makeScheduler() -> expo.RuntimeScheduler { expo.RuntimeScheduler() }\n');
    const target = 'arm64-apple-ios16.4';
    const diagnostics = run('xcrun', ['--sdk', 'iphoneos', 'swiftc', '-swift-version', '6',
      '-cxx-interoperability-mode=default', '-Xcc', '-std=c++20', '-Xcc', '-fblocks',
      '-sdk', sdkPath, '-target', target, '-module-cache-path', path.join(temporary, 'module-cache'),
      '-I', temporary, '-typecheck', consumer], { env });
    if (diagnostics) console.log(diagnostics);
    return { target, headerSha256: createHash('sha256').update(header).digest('hex'), passed: true };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export function verifyIosToolchain({
  repoRoot = fileURLToPath(new URL('..', import.meta.url)), env = process.env,
  run = runTool, platform = process.platform,
} = {}) {
  if (platform !== 'darwin') throw new Error('The iOS compiler preflight requires macOS');
  const output = (command, args) => run(command, args, { env }).trim();
  const info = {
    developerDirectory: env.DEVELOPER_DIR || output('xcode-select', ['-p']),
    xcode: output('xcodebuild', ['-version']),
    sdk: output('xcrun', ['--sdk', 'iphoneos', '--show-sdk-version']),
    sdkPath: output('xcrun', ['--sdk', 'iphoneos', '--show-sdk-path']),
    swift: output('xcrun', ['swiftc', '--version']),
    clang: output('xcrun', ['clang', '--version']),
    cocoaPods: output('pod', ['_1.17.0_', '--version']),
  };
  console.log(JSON.stringify(info, null, 2));
  assertIosToolchain(info, { pinned: env.LEX_IOS_REQUIRE_PINNED_TOOLCHAIN === '1' });
  const require = createRequire(path.join(repoRoot, 'apps/mobile/package.json'));
  const jsiPackage = require.resolve('expo-modules-jsi/package.json');
  const schedulerHeader = path.join(path.dirname(jsiPackage), 'apple/Sources/ExpoModulesJSI-Cxx/include/RuntimeScheduler.h');
  const interopProbe = probeIosSwiftInterop({ schedulerHeader, sdkPath: info.sdkPath, env, run });
  return { ...info, expoModulesJsi: JSON.parse(fs.readFileSync(jsiPackage, 'utf8')).version, interopProbe };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(verifyIosToolchain(), null, 2));
}
