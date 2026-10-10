import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchBuildGradleSigning, patchGradlePropertiesMemory } from '../apps/mobile/scripts/lib/android-local.mjs';
import mobileConfig from './shared/lex-mobile-config.cjs';
import { verifyAndroidCertificatePem } from './shared/android-certificate.mjs';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('..', import.meta.url));
const mobile = path.join(root, 'apps/mobile');
const signed = process.env.LEX_ANDROID_SIGNED === '1';
const version = process.env.LEX_MOBILE_VERSION;
const versionCode = mobileConfig.androidVersionCode(version);
if (process.env.LEX_MOBILE_BUILD !== '1') throw new Error('LEX_MOBILE_BUILD=1 is required');
if (process.platform !== 'linux') throw new Error('Use the Linux Android build workflow');
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: mobile, stdio: 'inherit', ...options });

// Signing material is supplied only to release jobs, never to PR builds.
if (signed) {
  for (const name of ['XDT_ANDROID_KEYSTORE_PATH', 'XDT_ANDROID_KEYSTORE_PASSWORD', 'XDT_ANDROID_KEY_ALIAS', 'XDT_ANDROID_KEY_PASSWORD', 'LEX_ANDROID_CERT_SHA256']) {
    if (!process.env[name]) throw new Error(`Missing ${name}`);
  }
  if (!/^[a-f0-9]{64}$/i.test(process.env.LEX_ANDROID_CERT_SHA256)) throw new Error('LEX_ANDROID_CERT_SHA256 must be 64 hex characters');
  const keyPath = path.resolve(process.env.XDT_ANDROID_KEYSTORE_PATH);
  const temp = path.resolve(process.env.RUNNER_TEMP);
  if (!keyPath.startsWith(temp + path.sep)) throw new Error('Keystore must stay in RUNNER_TEMP');
}

run('pnpm', ['exec', 'expo', 'prebuild', '--platform', 'android', '--no-install']);
const gradle = path.join(mobile, 'android/app/build.gradle');
const source = readFileSync(gradle, 'utf8');
if (signed) {
  writeFileSync(gradle, patchBuildGradleSigning(source));
} else {
  // CI compiles the actual release bundle without exposing a signing credential
  // or distributing an APK signed with a disposable/debug identity.
  const releaseSigning = /(buildTypes\s*\{[\s\S]*?\brelease\s*\{[\s\S]*?)signingConfig\s+signingConfigs\.debug/;
  if (!releaseSigning.test(source)) throw new Error('Expo release signing template changed');
  writeFileSync(gradle, source.replace(releaseSigning, '$1// Unsigned CI compilation'));
}
const properties = path.join(mobile, 'android/gradle.properties');
writeFileSync(properties, patchGradlePropertiesMemory(readFileSync(properties, 'utf8')));
const wrapper = path.join(mobile, 'android/gradlew');
chmodSync(wrapper, 0o755);
run(wrapper, ['assembleRelease', '--no-daemon', '--max-workers=2', '-PreactNativeArchitectures=arm64-v8a,armeabi-v7a,x86_64'], { cwd: path.join(mobile, 'android') });
const apk = path.join(mobile, `android/app/build/outputs/apk/release/app-release${signed ? '' : '-unsigned'}.apk`);
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
const toolsRoot = path.join(sdk, 'build-tools');
const toolVersion = readdirSync(toolsRoot).filter((name) => /^\d+\.\d+\.\d+$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
if (!toolVersion) throw new Error('No Android SDK build tools');
const sdkTool = (name, args) => execFileSync(path.join(toolsRoot, toolVersion, name), args, { encoding: 'utf8' });
const metadata = sdkTool('aapt', ['dump', 'badging', apk]);
if (!metadata.includes(`package: name='${mobileConfig.ANDROID_PACKAGE}' versionCode='${versionCode}' versionName='${version}'`)) throw new Error('APK installation identity/version mismatch');
if (!metadata.includes("application-label:'Lex'")) throw new Error('APK application label is not Lex');
if (metadata.includes('application-debuggable')) throw new Error('Release APK must not be debuggable');
// Invoke the Java CLI directly, avoiding SDK launcher wrapper differences.
const signer = (args) => execFileSync('java', ['-jar', path.join(toolsRoot, toolVersion, 'lib/apksigner.jar'), ...args], { encoding: 'utf8' });
const verify = (file, fingerprint) => {
  const certificate = signer(['verify', '--verbose', '--print-certs', '--print-certs-pem', file]);
  console.log(`Android build-tools ${toolVersion}:\n${certificate}`); // Public certificate only.
  verifyAndroidCertificatePem(certificate, fingerprint);
};
if (signed) {
  verify(apk, process.env.LEX_ANDROID_CERT_SHA256);
  const dist = path.join(root, 'dist/android');
  mkdirSync(dist, { recursive: true });
  copyFileSync(apk, path.join(dist, `Lex-${version}-Android.apk`));
} else {
  // Exercise the same real signer/verification path in PR CI with Expo's disposable
  // debug fixture key. This APK stays on the runner and is never uploaded.
  const fixtureKey = path.join(mobile, 'android/app/debug.keystore');
  const fixtureApk = path.join(process.env.RUNNER_TEMP, 'lex-signing-check.apk');
  const der = execFileSync('keytool', ['-exportcert', '-keystore', fixtureKey, '-storepass', 'android', '-alias', 'androiddebugkey']);
  signer(['sign', '--ks', fixtureKey, '--ks-key-alias', 'androiddebugkey', '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--out', fixtureApk, apk]);
  verify(fixtureApk, createHash('sha256').update(der).digest('hex'));
}
console.log(`Lex Android ${version}: ${signed ? 'signed APK verified' : 'unsigned CI compilation verified (not distributed)'}`);
