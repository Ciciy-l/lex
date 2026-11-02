// Resumable draft uploads. Existing versioned bytes are never replaced.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildAndroidManifest, sha256File } from './lex-android-updates.mjs';
import { buildIosManifest } from './lex-ios-updates.mjs';
import { iosReleaseIdentity } from './shared/lex-ios-release.cjs';
import { installerArtifactName, updateArtifactName } from '../apps/desktop/scripts/ci/package-lib.mjs';

const runGh = args => execFileSync('gh', args, { encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

export function optionalApi(endpoint, invoke = runGh) {
  // --include distinguishes a real HTTP 404 from auth/network failures.
  let response;
  try { response = invoke(['api', '--include', endpoint]); }
  catch (error) {
    if (/^HTTP\/\S+ 404\b/m.test(String(error.stdout ?? ''))) return null;
    throw error;
  }
  const boundary = /\r?\n\r?\n/.exec(response);
  if (!boundary) throw new Error('Missing GitHub API response headers');
  return JSON.parse(response.slice(boundary.index + boundary[0].length));
}

async function verifiedReleaseFiles(directory, version) {
  const identity = iosReleaseIdentity(version);
  const payloadNames = [];
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'x64']]) {
    const input = { platform, arch, version, versionless: false };
    payloadNames.push(installerArtifactName(input));
    if (platform !== 'linux') payloadNames.push(updateArtifactName(input));
  }
  payloadNames.push('Lex-' + version + '-Android.apk', 'Lex-' + version + '-Android.update.json',
    identity.assetName, identity.assetName.replace(/\.ipa$/, '.update.json'));
  const required = [...payloadNames, 'SHA256SUMS.txt'];
  const files = [];
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name !== 'build-info.json') files.push(file);
      else if (entry.isSymbolicLink()) throw new Error('Release assets cannot be symbolic links');
      else if (!entry.isFile()) throw new Error('Release assets must be regular files');
    }
  };
  visit(directory);
  if (new Set(files.map(file => path.basename(file))).size !== files.length) throw new Error('Duplicate release asset names');
  const byName = new Map(files.map(file => [path.basename(file), file]));
  const missing = required.filter(name => !byName.has(name));
  const unexpected = [...byName.keys()].filter(name => !required.includes(name));
  if (missing.length || unexpected.length) throw new Error('Incomplete or unexpected release assets; missing: '
    + missing.join(', ') + '; unexpected: ' + unexpected.join(', '));
  for (const file of files) if (!fs.statSync(file).size) throw new Error('Empty release asset: ' + path.basename(file));

  const sums = byName.get('SHA256SUMS.txt');
  if (fs.statSync(sums).size > 64 * 1024) throw new Error('Invalid release checksum manifest size');
  const checksums = new Map();
  for (const line of fs.readFileSync(sums, 'utf8').trimEnd().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64}) [ *](.+)$/i.exec(line);
    if (!match || !payloadNames.includes(match[2]) || checksums.has(match[2])) {
      throw new Error('Invalid or duplicate release checksum entry');
    }
    checksums.set(match[2], match[1].toLowerCase());
  }
  if (checksums.size !== payloadNames.length) throw new Error('Incomplete release checksum coverage');
  for (const name of payloadNames) {
    if (await sha256File(byName.get(name)) !== checksums.get(name)) throw new Error('Release checksum mismatch: ' + name);
  }
  // All twelve assets are validated locally before even reading GitHub state.
  return required.map(name => byName.get(name));
}

export async function publishDraft({ repo, version, commit, directory, notesFile, notice, certificateSha256, invoke = runGh,
  lookup = endpoint => optionalApi(endpoint, invoke) }) {
  const identity = iosReleaseIdentity(version);
  if (repo !== 'Ciciy-l/lex' || !/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('Invalid release target');
  const tag = 'v' + version;
  const files = await verifiedReleaseFiles(directory, version);
  const ipa = files.find(file => path.basename(file) === identity.assetName);
  // A succeeded upload job alone does not establish this artifact's identity.
  await buildIosManifest({ version, assets: path.dirname(ipa), notice, sourceCommit: commit, prerelease: version.includes('-') });
  const apk = files.find(file => path.basename(file) === 'Lex-' + version + '-Android.apk');
  await buildAndroidManifest({ version, assets: path.dirname(apk), notice, certificateSha256, prerelease: version.includes('-') });
  if (!fs.statSync(notesFile).size) throw new Error('Release notes are missing');

  // Manual dispatch can create a draft whose Git tag appears only on publication.
  const tagRef = lookup('repos/' + repo + '/git/ref/tags/' + tag);
  let taggedObject = tagRef?.object;
  for (let depth = 0; taggedObject?.type === 'tag' && depth < 5; depth++) {
    if (!/^[a-f0-9]{40}$/.test(taggedObject.sha ?? '')) throw new Error('Invalid release tag object');
    taggedObject = JSON.parse(invoke(['api', 'repos/' + repo + '/git/tags/' + taggedObject.sha])).object;
  }
  if (tagRef && (taggedObject?.type !== 'commit' || taggedObject.sha !== commit)) throw new Error('Release tag points to a different commit');
  // Listing failures must never be mistaken for an absent release.
  const releases = JSON.parse(invoke(['api', '--paginate', '--slurp', 'repos/' + repo + '/releases'])).flat();
  let release = releases.find(item => item.tag_name === tag);
  if (release) {
    if (!release.draft) throw new Error('Release is already published; use a higher version');
    if ((!tagRef && release.target_commitish !== commit) || release.prerelease !== version.includes('-')) {
      throw new Error('Existing draft target/channel differs');
    }
    if (release.assets.some(asset => !files.some(file => path.basename(file) === asset.name))
      || new Set(release.assets.map(asset => asset.name)).size !== release.assets.length) throw new Error('Unexpected existing draft assets');
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-draft-assets-'));
    try {
      // Validate all existing bytes before uploading even one missing asset.
      for (const file of files) {
        const name = path.basename(file);
        const asset = release.assets.find(item => item.name === name);
        if (!asset) continue;
        if (asset.state !== 'uploaded' || asset.size !== fs.statSync(file).size) throw new Error('Incomplete or changed draft asset: ' + name);
        invoke(['release', 'download', tag, '--repo', repo, '--pattern', name, '--dir', temporary]);
        if (await sha256File(file) !== await sha256File(path.join(temporary, name))) {
          throw new Error('Existing draft asset differs: ' + name + '. Reuse original CI artifacts or use a higher version.');
        }
      }
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  } else {
    invoke(['release', 'create', tag, '--repo', repo, '--target', commit, '--draft', '--title', 'Lex ' + tag,
      '--notes-file', notesFile, ...(version.includes('-') ? ['--prerelease'] : [])]);
    release = { assets: [] };
  }
  for (const file of files) {
    if (!release.assets.some(asset => asset.name === path.basename(file))) invoke(['release', 'upload', tag, file, '--repo', repo]);
  }
  // Check the receipt, not only command exit status; never publish here.
  const receipt = JSON.parse(invoke(['release', 'view', tag, '--repo', repo, '--json', 'isDraft,assets']));
  if (!receipt.isDraft || receipt.assets.length !== files.length || files.some(file => !receipt.assets.some(asset => asset.name === path.basename(file)
    && asset.state === 'uploaded' && asset.size === fs.statSync(file).size))) throw new Error('Draft upload receipt is incomplete or release was published concurrently');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = process.env.VERSION;
  iosReleaseIdentity(version); // Validate before interpolating a filesystem path.
  await publishDraft({ repo: process.env.GITHUB_REPOSITORY, version, commit: process.env.RELEASE_COMMIT,
    directory: 'dist', notesFile: process.argv[2], certificateSha256: process.env.LEX_ANDROID_CERT_SHA256,
    notice: JSON.parse(fs.readFileSync(new URL('../release-notices/' + version + '.json', import.meta.url), 'utf8')) });
  console.log('Draft assets uploaded. Publishing remains a separate maintainer action.');
}
