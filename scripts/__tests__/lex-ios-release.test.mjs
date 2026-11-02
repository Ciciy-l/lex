import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { iosReleaseIdentity } from '../shared/lex-ios-release.cjs';
import { androidVersionCode, ANDROID_PACKAGE } from '../shared/lex-mobile-config.cjs';
import { buildIosManifest, publishIosManifest } from '../lex-ios-updates.mjs';
import { sha256File } from '../lex-android-updates.mjs';
import { optionalApi, publishDraft } from '../publish-lex-draft.mjs';
import YAML from 'yaml';

async function fixture(t, version = '0.2.0-rc.1') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-ios-release-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const identity = iosReleaseIdentity(version);
  const ipa = path.join(directory, identity.assetName);
  fs.writeFileSync(ipa, 'synthetic unsigned IPA fixture');
  const metadata = { schemaVersion: 1, platform: 'ios', signing: 'unsigned', version,
    shortVersion: identity.shortVersion, buildNumber: identity.buildNumber, bundleIdentifier: identity.bundleIdentifier,
    minimumOSVersion: '16.4', size: fs.statSync(ipa).size, sha256: await sha256File(ipa), sourceCommit: 'a'.repeat(40), sourceDirty: false };
  const metadataFile = ipa.replace(/\.ipa$/, '.update.json');
  fs.writeFileSync(metadataFile, JSON.stringify(metadata));
  return { directory, ipa, metadataFile, metadata, input: { version, assets: directory, sourceCommit: metadata.sourceCommit,
    prerelease: version.includes('-'), notice: { version, date: '2026-11-02', contentByLocale: Object.fromEntries(
      ['zh-CN', 'zh-TW', 'en', 'ja', 'ko'].map(locale => [locale, { intro: 'Lex ' + locale, topics: [{ title: 'Changes', text: 'Fixture details' }] }])) } } };
}
test('Apple numeric version/build keep alpha < beta < rc < stable order', () => {
  const versions = ['0.2.0-alpha.1', '0.2.0-beta.1', '0.2.0-rc.1', '0.2.0'];
  assert.deepEqual(versions.map(v => iosReleaseIdentity(v).buildNumber), ['3.0.1', '3.0.31', '3.0.61', '3.0.99']);
  assert.equal(iosReleaseIdentity('0.0.1').buildNumber, '1.1.99');
  assert.equal(iosReleaseIdentity('0.1.15').buildNumber, '2.15.99');
  assert.equal(iosReleaseIdentity('0.2.0-rc.1').shortVersion, '0.2.0');
  for (const version of ['0.2.100', '0.2.0+build', '0.2.0-rc.30', '../unsafe', '0.02.0']) assert.throws(() => iosReleaseIdentity(version));
});
test('publishes only verified artifact bytes from the exact release commit', async t => {
  const f = await fixture(t);
  const manifest = await buildIosManifest(f.input);
  assert.equal(manifest.file, 'https://github.com/Ciciy-l/lex/releases/download/v0.2.0-rc.1/Lex-0.2.0-rc.1-iOS-unsigned.ipa');
  assert.equal(manifest.signing, 'unsigned');
  assert.equal(Object.keys(manifest.contentByLocale).length, 5);
  await assert.rejects(buildIosManifest({ ...f.input, sourceCommit: 'b'.repeat(40) }), /does not match/);
  await assert.rejects(buildIosManifest({ ...f.input, prerelease: false }), /channel/);
  fs.writeFileSync(f.ipa, 'replaced bytes');
  await assert.rejects(buildIosManifest(f.input), /does not match/);
});
test('missing assets and invalid package, build, size, OS and digest fail closed', async t => {
  const f = await fixture(t);
  for (const fields of [{ bundleIdentifier: 'other' }, { buildNumber: '99' }, { size: -1 },
    { minimumOSVersion: 'javascript:bad' }, { sha256: 'x'.repeat(64) }, { signing: 'signed' }, { sourceDirty: true }]) {
    fs.writeFileSync(f.metadataFile, JSON.stringify({ ...f.metadata, ...fields }));
    await assert.rejects(buildIosManifest(f.input), /Invalid/);
  }
  fs.writeFileSync(f.metadataFile, JSON.stringify(f.metadata)); fs.unlinkSync(f.ipa);
  await assert.rejects(buildIosManifest(f.input));
});
test('stable advances both channels, backports cannot regress beta, retry is immutable', async t => {
  const stable = await fixture(t, '0.2.0'), rc = await fixture(t, '0.3.0-rc.1');
  const a = await buildIosManifest(stable.input), b = await buildIosManifest(rc.input);
  const destination = path.join(stable.directory, 'updates');
  const read = suffix => JSON.parse(fs.readFileSync(path.join(destination, 'manifest-ios' + suffix + '.json')));
  publishIosManifest(a, destination); publishIosManifest(b, destination); publishIosManifest(a, destination);
  assert.equal(read('').version, a.version); assert.equal(read('-beta').version, b.version);
  assert.throws(() => publishIosManifest({ ...b, sha256: 'f'.repeat(64) }, destination), /different bytes/);
  assert.equal(read('-beta').sha256, b.sha256);
});

// Expected public asset names are independent from the publisher's naming helper.
const releaseSuffixes = ['Windows-x64-Setup.exe', 'Windows-x64-Auto-Update.zip',
  'macOS-Apple-Silicon.dmg', 'macOS-Apple-Silicon-Auto-Update.zip', 'macOS-Intel.dmg',
  'macOS-Intel-Auto-Update.zip', 'Linux-x64.deb', 'Android.apk', 'Android.update.json',
  'iOS-unsigned.ipa', 'iOS-unsigned.update.json'];
async function draftFixture(t, version = '0.1.15') {
  const f = await fixture(t, version);
  const directory = path.join(f.directory, 'assets'); fs.mkdirSync(directory);
  for (const file of [f.ipa, f.metadataFile]) fs.renameSync(file, path.join(directory, path.basename(file)));
  const assetNames = releaseSuffixes.map(suffix => 'Lex-' + version + '-' + suffix);
  for (const name of assetNames) {
    if (!fs.existsSync(path.join(directory, name))) fs.writeFileSync(path.join(directory, name), 'synthetic ' + name);
  }
  const apk = path.join(directory, 'Lex-' + version + '-Android.apk');
  const certificateSha256 = 'c'.repeat(64);
  fs.writeFileSync(apk.replace(/\.apk$/, '.update.json'), JSON.stringify({ schemaVersion: 1, version,
    versionCode: androidVersionCode(version), packageName: ANDROID_PACKAGE, certificateSha256,
    size: fs.statSync(apk).size, sha256: await sha256File(apk) }));
  const checksumFile = path.join(directory, 'SHA256SUMS.txt');
  const writeChecksums = async () => fs.writeFileSync(checksumFile, (await Promise.all(assetNames.map(async name =>
    await sha256File(path.join(directory, name)) + '  ' + name))).join('\n') + '\n');
  await writeChecksums();
  fs.writeFileSync(path.join(directory, 'build-info.json'), '{"notAReleaseAsset":true}');
  const notesFile = path.join(f.directory, 'notes fixture.md'); fs.writeFileSync(notesFile, 'Lex release notes\n\nSelf-sign this IPA.\n');
  const remote = new Map(); const calls = []; let release; let failAfter = null;
  const invoke = args => {
    calls.push(args);
    if (args[0] === 'api') return JSON.stringify([release ? [release] : []]);
    if (args[1] === 'create') {
      release = { tag_name: args[2], target_commitish: args[args.indexOf('--target') + 1],
        name: args[args.indexOf('--title') + 1], body: fs.readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8'),
        draft: args.includes('--draft'), prerelease: args.includes('--prerelease'), assets: [] };
    } else if (args[1] === 'upload') {
      if (failAfter === 0) { failAfter = null; throw new Error('Synthetic upload failure'); }
      if (failAfter !== null) failAfter--;
      const file = args[3], name = path.basename(file); remote.set(name, fs.readFileSync(file));
      release.assets.push({ name, size: fs.statSync(file).size, state: 'uploaded' });
    } else if (args[1] === 'download') {
      const name = args[args.indexOf('--pattern') + 1];
      fs.writeFileSync(path.join(args[args.indexOf('--dir') + 1], name), remote.get(name));
    } else if (args[1] === 'view') return JSON.stringify({ isDraft: release.draft, assets: release.assets });
    return '';
  };
  return { input: { repo: 'Ciciy-l/lex', version, commit: f.metadata.sourceCommit, directory,
    notesFile, notice: f.input.notice, certificateSha256, invoke, lookup: () => null }, calls, remote, checksumFile, writeChecksums,
    assetNames: [...assetNames, 'SHA256SUMS.txt'], get release() { return release; },
    failUpload: (after = 0) => { failAfter = after; } };
}
test('draft creation and retries upload missing assets only, even before the Git tag exists', async t => {
  const f = await draftFixture(t); f.failUpload(3);
  await assert.rejects(publishDraft(f.input), /Synthetic upload/);
  assert.equal(f.remote.size, 3);
  await publishDraft(f.input); await publishDraft(f.input);
  assert.equal(f.calls.filter(args => args[1] === 'create').length, 1);
  assert.equal(f.calls.filter(args => args[1] === 'upload').length, 13); // one failure + twelve assets
  assert.deepEqual([...f.remote.keys()].sort(), f.assetNames.slice().sort());
  assert.ok(f.calls.some(args => args[1] === 'download')); // verifies earlier partial uploads
  assert.ok(f.calls.every(args => !args.includes('--clobber') && args[1] !== 'edit'));
});
for (const version of ['0.1.15', '0.1.15-rc.1']) {
  test('publishes exact notes/title/draft/channel parameters for ' + version, async t => {
    const f = await draftFixture(t, version); await publishDraft(f.input);
    assert.deepEqual(f.calls.find(args => args[1] === 'create'), ['release', 'create', 'v' + version,
      '--repo', 'Ciciy-l/lex', '--target', f.input.commit, '--draft', '--title', 'Lex v' + version,
      '--notes-file', f.input.notesFile, ...(version.includes('-') ? ['--prerelease'] : [])]);
    assert.equal(f.release.body, fs.readFileSync(f.input.notesFile, 'utf8'));
    assert.equal(f.release.name, 'Lex v' + version); assert.equal(f.release.draft, true);
    assert.equal(f.release.prerelease, version.includes('-'));
    assert.deepEqual([...f.remote.keys()].sort(), f.assetNames.slice().sort());
  });
}
test('retry rejects changed bytes, published releases, wrong targets and incomplete receipts', async t => {
  const f = await draftFixture(t); await publishDraft(f.input);
  const mutations = () => f.calls.filter(args => ['create', 'upload'].includes(args[1])).length;
  const before = mutations(); const name = [...f.remote.keys()][0], bytes = f.remote.get(name);
  f.remote.set(name, Buffer.alloc(bytes.length, 120));
  await assert.rejects(publishDraft(f.input), /asset differs/); assert.equal(mutations(), before);
  f.remote.set(name, bytes); f.release.draft = false;
  await assert.rejects(publishDraft(f.input), /already published/); assert.equal(mutations(), before);
  f.release.draft = true;
  await assert.rejects(publishDraft({ ...f.input, lookup: () => ({ object: { type: 'commit', sha: 'f'.repeat(40) } }) }), /different commit/);
  f.release.target_commitish = 'f'.repeat(40);
  await assert.rejects(publishDraft(f.input), /target\/channel differs/);
  f.release.target_commitish = f.input.commit;
  f.release.assets.push({ name: 'unexpected.zip', size: 1, state: 'uploaded' });
  await assert.rejects(publishDraft(f.input), /Unexpected existing draft assets/);
  f.release.assets.pop();
  await assert.rejects(publishDraft({ ...f.input, invoke: args => args[1] === 'view'
    ? JSON.stringify({ isDraft: true, assets: [] }) : f.input.invoke(args) }), /receipt is incomplete/);
  assert.equal(mutations(), before);
});
test('an annotated release tag resolves to the verified source commit', async t => {
  const f = await draftFixture(t);
  await publishDraft({ ...f.input, lookup: () => ({ object: { type: 'tag', sha: 'e'.repeat(40) } }),
    invoke: args => args[0] === 'api' && args[1].includes('/git/tags/')
      ? JSON.stringify({ object: { type: 'commit', sha: f.input.commit } }) : f.input.invoke(args) });
  assert.equal(f.release.draft, true); assert.equal(f.remote.size, 12);
});
test('each missing mandatory asset fails before any GitHub operation, including both sidecars and checksums', async t => {
  for (const name of [...releaseSuffixes.map(suffix => 'Lex-0.1.15-' + suffix), 'SHA256SUMS.txt']) {
    await t.test(name, async child => {
      const f = await draftFixture(child);
      fs.unlinkSync(path.join(f.input.directory, name));
      await assert.rejects(publishDraft(f.input), /release assets/); assert.equal(f.calls.length, 0);
    });
  }
});
test('only IPA and sidecar cannot create an incomplete draft', async t => {
  const f = await draftFixture(t);
  for (const name of f.assetNames.filter(name => !name.includes('-iOS-unsigned.'))) fs.unlinkSync(path.join(f.input.directory, name));
  await assert.rejects(publishDraft(f.input), /release assets/); assert.equal(f.calls.length, 0);
});
test('checksum coverage, content, versions and exact asset set fail closed before remote mutation', async t => {
  for (const scenario of ['missing checksum entry', 'duplicate entry', 'unexpected entry', 'wrong version entry',
    'bad digest', 'tampered payload', 'extra file', 'duplicate asset', 'wrong version asset', 'empty asset']) {
    await t.test(scenario, async child => {
      const f = await draftFixture(child), name = f.assetNames[0], file = path.join(f.input.directory, name);
      const sums = fs.readFileSync(f.checksumFile, 'utf8'), lines = sums.trimEnd().split('\n');
      if (scenario === 'missing checksum entry') fs.writeFileSync(f.checksumFile, lines.slice(1).join('\n') + '\n');
      if (scenario === 'duplicate entry') fs.writeFileSync(f.checksumFile, sums + lines[0] + '\n');
      if (scenario === 'unexpected entry') fs.writeFileSync(f.checksumFile, sums + 'a'.repeat(64) + '  build-info.json\n');
      if (scenario === 'wrong version entry') fs.writeFileSync(f.checksumFile, sums.replace(name, name.replace('0.1.15', '0.1.14')));
      if (scenario === 'bad digest') fs.writeFileSync(f.checksumFile, '0'.repeat(64) + sums.slice(64));
      if (scenario === 'tampered payload') fs.appendFileSync(file, 'changed');
      if (scenario === 'extra file') fs.writeFileSync(path.join(f.input.directory, 'unexpected.zip'), 'extra');
      if (scenario === 'duplicate asset') {
        const nested = path.join(f.input.directory, 'duplicate'); fs.mkdirSync(nested);
        fs.copyFileSync(file, path.join(nested, name));
      }
      if (scenario === 'wrong version asset') fs.renameSync(file, file.replace('0.1.15', '0.1.14'));
      if (scenario === 'empty asset') fs.writeFileSync(file, '');
      await assert.rejects(publishDraft(f.input)); assert.equal(f.calls.length, 0);
    });
  }
});
test('a matching checksum file cannot hide wrong Android metadata or a different signing identity', async t => {
  const f = await draftFixture(t);
  const file = path.join(f.input.directory, 'Lex-0.1.15-Android.update.json');
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const patch of [{ version: '0.1.14' }, { versionCode: 1 }, { sha256: 'e'.repeat(64) },
    { size: original.size + 1 }, { packageName: 'other' }, { certificateSha256: 'd'.repeat(64) }]) {
    fs.writeFileSync(file, JSON.stringify({ ...original, ...patch })); await f.writeChecksums();
    await assert.rejects(publishDraft(f.input), /Android artifact/); assert.equal(f.calls.length, 0);
  }
});
test('API lookup distinguishes a missing tag from network and permission errors', () => {
  assert.equal(optionalApi('fixture', () => { throw { stdout: 'HTTP/2.0 404 Not Found\n\n{}' }; }), null);
  assert.throws(() => optionalApi('fixture', () => { throw new Error('offline'); }), /offline/);
  assert.throws(() => optionalApi('fixture', () => { throw { stdout: 'HTTP/2.0 403 Forbidden\n\n{}' }; }));
  assert.deepEqual(optionalApi('fixture', () => 'HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n{"sha":"fixture"}'), { sha: 'fixture' });
});
test('versioned release waits for iOS; standalone iOS dispatch only uploads an Actions artifact', () => {
  const read = file => fs.readFileSync(new URL('../../.github/workflows/' + file, import.meta.url), 'utf8');
  const release = YAML.parse(read('desktop-release.yml'));
  assert.ok(release.jobs.publish.needs.includes('ios'));
  assert.deepEqual(release.jobs.ios.needs, ['eligibility', 'resolve-release']);
  const ios = YAML.parse(read('mobile-ios.yml'));
  assert.equal(ios.permissions.contents, 'read');
  assert.equal(ios.jobs.ios.env.LEX_MOBILE_BUILD, '1');
  assert.ok(ios.jobs.ios.steps.some(step => step.with?.path?.includes('-iOS-unsigned.ipa')));
  assert.ok(ios.jobs.ios.steps.every(step => !step.run?.includes('gh release')));
  const updates = read('lex-updates.yml');
  assert.ok(updates.indexOf('Download uploaded iOS artifacts') < updates.indexOf('node scripts/lex-ios-updates.mjs'));
  assert.deepEqual(YAML.parse(updates).on.release.types, ['published']);
});
