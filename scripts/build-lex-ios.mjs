import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { iosReleaseIdentity } from './shared/lex-ios-release.cjs';
import { sha256File } from './lex-android-updates.mjs';
import { mobileClientBundleProcessEnv } from './shared/client-endpoint-build-env.mjs';
import { verifyIosToolchain } from './check-lex-ios-toolchain.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const mobile = path.join(root, 'apps/mobile');
const identity = iosReleaseIdentity(process.env.LEX_MOBILE_VERSION);
if (process.platform !== 'darwin') throw new Error('Use macOS with Xcode for iphoneos builds');
if (process.env.LEX_MOBILE_BUILD !== '1') throw new Error('LEX_MOBILE_BUILD=1 is required');
// Never overwrite a developer's native project or local build settings.
if (fs.existsSync(path.join(mobile, 'ios'))) throw new Error('apps/mobile/ios already exists; build in a clean checkout');
for (const key of ['EAS_OWNER', 'EAS_PROJECT_ID', 'EAS_BUILD_PROFILE', 'EXPO_PUBLIC_XDT_OTA_SELFHOST',
  'CINDY_USE_LOCAL_REGION_CONFIG', 'CINDY_MOBILE_OTA_NATIVE', 'CINDY_MOBILE_UPDATES_URL',
  'XDT_REQUIRE_APP_STORE_ID', 'EXPO_PUBLIC_APP_VARIANT', 'EXPO_PUBLIC_CINDY_GOOGLE_IOS_URL_SCHEME',
  'EXPO_PUBLIC_CINDY_WECHAT_APP_ID', 'EXPO_PUBLIC_CINDY_WECHAT_UNIVERSAL_LINK']) {
  if (process.env[key]) throw new Error(`Unsigned Lex build cannot inherit ${key}`);
}
const env = { ...mobileClientBundleProcessEnv({ authRegion: 'global' }),
  LEX_MOBILE_BUILD: '1', LEX_MOBILE_VERSION: identity.version, CI: '1',
  EXPO_NO_DOTENV: '1', NODE_ENV: 'production', NODE_BINARY: process.execPath,
  FORCE_BUNDLING: '1' };
delete env.SKIP_BUNDLING;
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: mobile, env, stdio: 'inherit', ...options });
const output = (command, args) => run(command, args, { encoding: 'utf8', stdio: 'pipe' }).trim();
const sourceCommit = output('git', ['rev-parse', 'HEAD']);
// Developer artifacts may exercise uncommitted code, but must never be mistaken
// for immutable release evidence. The publisher rejects a dirty source marker.
const sourceDirty = output('git', ['status', '--porcelain', '--untracked-files=normal']) !== '';
// Fail before prebuild/Pods on unsupported Swift importers. The same selected
// DEVELOPER_DIR is inherited by ExpoModulesJSI's nested SwiftPM xcodebuild.
const toolchain = verifyIosToolchain({ repoRoot: root, env });
const dist = path.join(root, 'dist/ios');
fs.mkdirSync(dist, { recursive: true });
const ipa = path.join(dist, identity.assetName);
const metadataFile = ipa.replace(/\.ipa$/, '.update.json');
const buildInfoFile = path.join(dist, 'build-info.json');
if ([ipa, metadataFile, buildInfoFile].some(file => fs.existsSync(file))) throw new Error('iOS output already exists; use a fresh output directory');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-ios-build-'));
try {
  run('pnpm', ['exec', 'expo', 'prebuild', '--platform', 'ios', '--no-install',
    '--skip-dependency-update', 'react,react-native']);
  const ios = path.join(mobile, 'ios');
  const projects = fs.readdirSync(ios).filter(name => name.endsWith('.xcodeproj'));
  if (projects.length !== 1) throw new Error('Expected one generated iOS project');
  const scheme = projects[0].replace(/\.xcodeproj$/, '');
  const plist = path.join(ios, scheme, 'Info.plist');
  // Expo config keeps SemVer; Apple's native version/build use numeric components.
  run('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleShortVersionString ${identity.shortVersion}`, plist]);
  run('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleVersion ${identity.buildNumber}`, plist]);
  run('pod', ['_1.17.0_', 'install'], { cwd: ios });
  if (!fs.readFileSync(path.join(ios, 'Podfile.lock'), 'utf8').includes('LexServiceWebSocket')) {
    throw new Error('The Lex iOS native WebSocket transport is missing from autolinked pods');
  }
  const archive = path.join(temporary, 'Lex.xcarchive');
  run('xcodebuild', ['-workspace', path.join(ios, `${scheme}.xcworkspace`), '-scheme', scheme,
    '-configuration', 'Release', '-sdk', 'iphoneos', '-destination', 'generic/platform=iOS',
    '-archivePath', archive, '-derivedDataPath', path.join(temporary, 'DerivedData'), 'archive',
    'ARCHS=arm64', 'ONLY_ACTIVE_ARCH=NO', 'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO',
    'CODE_SIGN_IDENTITY=', 'DEVELOPMENT_TEAM=',
    `MARKETING_VERSION=${identity.shortVersion}`, `CURRENT_PROJECT_VERSION=${identity.buildNumber}`,
    'SWIFT_ENABLE_EXPLICIT_MODULES=NO', 'CLANG_ENABLE_EXPLICIT_MODULES=NO']);
  const apps = path.join(archive, 'Products/Applications');
  const names = fs.readdirSync(apps).filter(name => name.endsWith('.app'));
  if (names.length !== 1) throw new Error('Expected one archived iPhone application');
  const payload = path.join(temporary, 'Payload'); fs.mkdirSync(payload);
  const app = path.join(payload, names[0]);
  run('ditto', [path.join(apps, names[0]), app]);
  const info = JSON.parse(output('plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Info.plist')]));
  if (info.CFBundleIdentifier !== identity.bundleIdentifier || info.CFBundleShortVersionString !== identity.shortVersion
    || info.CFBundleVersion !== identity.buildNumber || info.CFBundleSupportedPlatforms?.join() !== 'iPhoneOS'
    || !/^\d+\.\d+(?:\.\d+)?$/.test(info.MinimumOSVersion)
    || !fs.statSync(path.join(app, 'main.jsbundle')).size) throw new Error('Invalid offline iPhone app identity/bundle');
  const executable = path.join(app, info.CFBundleExecutable);
  if (output('xcrun', ['lipo', '-archs', executable]) !== 'arm64'
    || !/^\s*platform IOS\s*$/m.test(output('xcrun', ['vtool', '-show-build', executable]))) {
    throw new Error('IPA must contain an arm64 device executable');
  }
  // Strip linker/vendor signatures too. Never ship a publisher profile.
  const strip = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.name === '_CodeSignature' || entry.name === 'embedded.mobileprovision') {
        fs.rmSync(file, { recursive: true, force: true }); continue;
      }
      if (entry.isDirectory()) strip(file);
      else if (entry.isFile() && output('file', ['-b', file]).includes('Mach-O')) {
        if (spawnSync('codesign', ['-d', file], { stdio: 'ignore' }).status === 0) run('codesign', ['--remove-signature', file]);
        if (spawnSync('codesign', ['-d', file], { stdio: 'ignore' }).status === 0) throw new Error('Signature remains in IPA');
      }
    }
  };
  strip(app);
  fs.writeFileSync(buildInfoFile, JSON.stringify({
    sourceCommit, sourceDirty, xcode: toolchain.xcode, sdk: toolchain.sdk,
    cocoaPods: toolchain.cocoaPods, toolchain, node: process.version,
    minimumOSVersion: info.MinimumOSVersion, architecture: 'arm64',
    podfileLock: fs.readFileSync(path.join(ios, 'Podfile.lock'), 'utf8'),
  }, null, 2) + '\n');
  // keepParent preserves Payload/. exportArchive would require signing.
  run('ditto', ['-c', '-k', '--keepParent', '--norsrc', payload, ipa]);
  fs.writeFileSync(metadataFile, JSON.stringify({
    schemaVersion: 1, platform: 'ios', signing: 'unsigned', version: identity.version,
    shortVersion: identity.shortVersion, buildNumber: identity.buildNumber, bundleIdentifier: identity.bundleIdentifier,
    minimumOSVersion: info.MinimumOSVersion, size: fs.statSync(ipa).size, sha256: await sha256File(ipa), sourceCommit, sourceDirty,
  }, null, 2) + '\n');
  console.log(`Unsigned iphoneos arm64 IPA: ${ipa}. Signing and installation are the user's responsibility.`);
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
