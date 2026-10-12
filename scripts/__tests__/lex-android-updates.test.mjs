import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildAndroidManifest, publishAndroidManifest, sha256File } from '../lex-android-updates.mjs';
import { androidVersionCode } from '../shared/lex-mobile-config.cjs';

async function fixture(t, version = '0.1.5-rc.1') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-apk-update-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const assets = path.join(directory, 'assets'); fs.mkdirSync(assets);
  const base = path.join(assets, 'Lex-' + version + '-Android');
  fs.writeFileSync(base + '.apk', 'fixture APK bytes');
  const metadata = { schemaVersion: 1, version, versionCode: androidVersionCode(version),
    packageName: 'io.github.ciciyl.lex', size: fs.statSync(base + '.apk').size,
    sha256: await sha256File(base + '.apk'), certificateSha256: 'ab'.repeat(32) };
  fs.writeFileSync(base + '.update.json', JSON.stringify(metadata));
  const notice = { version, date: '2026-10-12', contentByLocale: Object.fromEntries(
    ['zh-CN', 'zh-TW', 'en', 'ja', 'ko'].map(locale => [locale, { intro: 'Lex ' + locale, topics: [{ title: 'Fixes', text: 'Details' }] }])) };
  return { directory, base, metadata, input: { version, assets, notice,
    certificateSha256: metadata.certificateSha256, prerelease: version.includes('-') } };
}

test('publishes immutable APK identity and all five release-note languages', async t => {
  const { directory, input, metadata } = await fixture(t);
  const manifest = await buildAndroidManifest(input);
  assert.equal(manifest.sha256, metadata.sha256);
  assert.equal(manifest.file, 'https://github.com/Ciciy-l/lex/releases/download/v0.1.5-rc.1/Lex-0.1.5-rc.1-Android.apk');
  assert.deepEqual(Object.keys(manifest.contentByLocale), ['zh-CN', 'zh-TW', 'en', 'ja', 'ko']);
  const destination = path.join(directory, 'updates'); publishAndroidManifest(manifest, destination);
  assert.ok(fs.existsSync(path.join(destination, 'manifest-android-beta.json')));
  assert.equal(fs.existsSync(path.join(destination, 'manifest-android.json')), false);
});

test('rejects missing languages, mismatched channel/certificate, and changed APK bytes', async t => {
  const { input, base } = await fixture(t);
  await assert.rejects(buildAndroidManifest({ ...input, certificateSha256: 'cd'.repeat(32) }), /does not match/);
  await assert.rejects(buildAndroidManifest({ ...input, prerelease: false }), /channel/);
  const notice = structuredClone(input.notice); delete notice.contentByLocale.ko;
  await assert.rejects(buildAndroidManifest({ ...input, notice }), /ko/);
  fs.writeFileSync(base + '.apk', 'different bytes!');
  await assert.rejects(buildAndroidManifest(input), /does not match/);
});

test('stable graduates beta, a later RC advances beta only, and backports never lower pointers', async t => {
  const { directory, input } = await fixture(t, '0.1.5');
  const manifest = await buildAndroidManifest(input); const destination = path.join(directory, 'updates');
  const read = suffix => JSON.parse(fs.readFileSync(path.join(destination, 'manifest-android' + suffix + '.json'), 'utf8'));
  publishAndroidManifest(manifest, destination);
  assert.equal(read('').version, '0.1.5'); assert.equal(read('-beta').version, '0.1.5');
  const rcFixture = await fixture(t, '0.1.6-rc.1'); const rc = await buildAndroidManifest(rcFixture.input);
  publishAndroidManifest(rc, destination);
  publishAndroidManifest(manifest, destination);
  assert.equal(read('').version, '0.1.5'); assert.equal(read('-beta').version, '0.1.6-rc.1');
  assert.throws(() => publishAndroidManifest({ ...rc, sha256: 'cc'.repeat(32) }, destination), /different bytes/);
});
