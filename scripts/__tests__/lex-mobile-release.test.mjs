import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { verifyAndroidCertificate } from '../shared/android-certificate.mjs';
import YAML from 'yaml';
import { androidVersionCode, lexMobileConfig } from '../shared/lex-mobile-config.cjs';

const read = (name) => fs.readFileSync(new URL('../../' + name, import.meta.url), 'utf8');

test('certificate check accepts SDK-ranged signers and rejects missing or different certificates', () => {
  const digest = 'ab'.repeat(32);
  for (const label of ['Signer #1', 'Signer (minSdkVersion=28, maxSdkVersion=2147483647)', 'Signer (minSdkVersion=33 (dev release=true), maxSdkVersion=2147483647)']) {
    const output = `${label} certificate SHA-256 digest: ${digest}`;
    assert.doesNotThrow(() => verifyAndroidCertificate(output, digest.toUpperCase()));
    assert.throws(() => verifyAndroidCertificate(output, 'cd'.repeat(32)), /does not match/);
  }
  assert.throws(() => verifyAndroidCertificate(`Signer #1 public key SHA-256 digest: ${digest}`, digest), /No signer/);
  assert.throws(() => verifyAndroidCertificate('', digest), /No signer/);
  assert.throws(() => verifyAndroidCertificate(`Signer #1 certificate SHA-256 digest: ${digest}\nSigner #2 certificate SHA-256 digest: ${'cd'.repeat(32)}`, digest), /does not match/);
});

test('Android versions increase through prereleases, stable and later versions', () => {
  const versions = ['0.1.97-alpha.1', '0.1.97-alpha.29', '0.1.97-beta.1', '0.1.97-beta.29', '0.1.97-rc.1', '0.1.97-rc.29', '0.1.97', '0.1.98-alpha.1', '0.2.0', '1.0.0'];
  const codes = versions.map(androidVersionCode);
  assert.deepEqual(codes, [...codes].sort((a, b) => a - b));
  assert.equal(new Set(codes).size, versions.length);
  for (const value of ['', '1.2', '01.2.3', '1.2.3-rc.30', '1.100.1', '2001.0.0', '1.2.3-rc.0', '1.2.3+metadata']) {
    assert.throws(() => androidVersionCode(value));
  }
  assert.ok(androidVersionCode('20.99.9999') < 2100000000);
});

test('Lex variant preserves service configuration but cannot inherit another OTA project', () => {
  const base = { scheme: 'cindy', android: { package: 'com.xd.cindy' }, ios: {}, extra: { cindy: { authRegion: 'global' } }, plugins: [] };
  assert.equal(lexMobileConfig(base, {}), base);
  const env = { LEX_MOBILE_BUILD: '1', LEX_MOBILE_VERSION: '0.1.97' };
  const result = lexMobileConfig(base, env);
  assert.equal(result.android.package, 'io.github.ciciyl.lex');
  assert.equal(result.scheme, base.scheme);
  assert.equal(result.extra, base.extra);
  assert.deepEqual(result.updates, { enabled: false });
  assert.equal(base.android.package, 'com.xd.cindy');
  for (const key of ['EXPO_PUBLIC_XDT_OTA_SELFHOST', 'EAS_PROJECT_ID', 'EAS_OWNER', 'CINDY_USE_LOCAL_REGION_CONFIG']) {
    assert.throws(() => lexMobileConfig(base, { ...env, [key]: '1' }));
  }
});

test('release waits for signed Android while PR compilation cannot upload an APK', () => {
  const release = YAML.parse(read('.github/workflows/desktop-release.yml'));
  const workflow = YAML.parse(read('.github/workflows/mobile-android.yml'));
  assert.ok(release.jobs.publish.needs.includes('android'));
  assert.equal(release.jobs.android.with.signed, true);
  assert.deepEqual(release.jobs.android.needs, ['eligibility', 'resolve-release']);
  const upload = workflow.jobs.android.steps.find((step) => step.name === 'Upload installable APK');
  assert.equal(upload.if, 'inputs.signed');
  assert.equal(workflow.on.pull_request_target, undefined);
  assert.equal(workflow.jobs.android.steps.at(-1).if, 'always()');
  assert.equal(YAML.parse(read('.github/workflows/upstream-sync.yml')).on.schedule, undefined);
});

async function renderDownload({ ua, platform, touch = 0, assets = [], failed = false }) {
  const nodes = new Map();
  const element = () => ({ dataset: {}, textContent: '', href: 'https://github.com/Ciciy-l/lex/releases', setAttribute() {}, addEventListener() {}, replaceChildren() {} });
  const get = (key) => { if (!nodes.has(key)) nodes.set(key, element()); return nodes.get(key); };
  const document = { documentElement: element(), getElementById: get, querySelector: get, createElement: element, createTextNode: (text) => text };
  const html = read('website/index.html');
  const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(code, { document, navigator: { userAgent: ua, platform, maxTouchPoints: touch, language: 'zh-CN' }, window: {}, localStorage: { getItem() { return null; }, setItem() {} }, fetch: async () => ({ ok: !failed, json: async () => ({ version: '1.0.0', assets, releaseUrl: 'https://github.com/Ciciy-l/lex/releases/tag/v1.0.0' }) }) });
  await new Promise((resolve) => setImmediate(resolve));
  return nodes;
}

test('mobile browsers get only published APKs, iPad gets iOS status, never Linux installers', async () => {
  const apk = { name: 'Lex-1.0.0-Android.apk', url: 'https://github.com/Ciciy-l/lex/releases/download/v1.0.0/Lex-1.0.0-Android.apk' };
  const deb = { name: 'Lex-1.0.0-Linux-x64.deb', url: 'https://example.invalid/file.deb' };
  const android = await renderDownload({ ua: 'Android', platform: 'Linux armv8l', assets: [deb, apk] });
  assert.equal(android.get('download').href, apk.url);
  assert.equal(android.get('download-android').href, apk.url);
  const missing = await renderDownload({ ua: 'Android', platform: 'Linux', assets: [deb] });
  assert.ok(missing.get('download').href.includes('/releases/tag/'));
  const ipad = await renderDownload({ ua: 'Safari', platform: 'MacIntel', touch: 5, assets: [apk, deb] });
  assert.equal(ipad.get('download').href, '#mobile-download');
  const failed = await renderDownload({ ua: 'Android', platform: 'Linux', failed: true });
  assert.equal(failed.get('download').href, 'https://github.com/Ciciy-l/lex/releases');
});
