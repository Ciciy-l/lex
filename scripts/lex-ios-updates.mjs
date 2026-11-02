import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { iosReleaseIdentity } from './shared/lex-ios-release.cjs';
import { androidVersionCode } from './shared/lex-mobile-config.cjs';
import { sha256File } from './lex-android-updates.mjs';
import { LOCALES, validateNotice } from './lex-release-notices.mjs';

export function validateIosMetadata(metadata, version) {
  const identity = iosReleaseIdentity(version);
  if (!metadata || metadata.schemaVersion !== 1 || metadata.platform !== 'ios'
    || metadata.signing !== 'unsigned' || metadata.version !== version
    || metadata.sourceDirty !== false
    || metadata.shortVersion !== identity.shortVersion || metadata.buildNumber !== identity.buildNumber
    || metadata.bundleIdentifier !== identity.bundleIdentifier
    || typeof metadata.minimumOSVersion !== 'string'
    || !/^(?:[1-9]\d?)\.\d{1,2}(?:\.\d{1,2})?$/.test(metadata.minimumOSVersion)
    || !Number.isSafeInteger(metadata.size) || metadata.size <= 0 || metadata.size > 8 * 1024 ** 3
    || typeof metadata.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.sha256)
    || typeof metadata.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(metadata.sourceCommit)) {
    throw new Error('Invalid unsigned iOS artifact metadata');
  }
  // Project only known fields. No URL, credentials or arbitrary publisher fields flow through.
  return { schemaVersion: 1, platform: 'ios', signing: 'unsigned', version,
    shortVersion: identity.shortVersion, buildNumber: identity.buildNumber,
    bundleIdentifier: identity.bundleIdentifier, minimumOSVersion: metadata.minimumOSVersion,
    size: metadata.size, sha256: metadata.sha256, sourceCommit: metadata.sourceCommit, sourceDirty: false };
}

export async function buildIosManifest({ version, assets, notice, prerelease, sourceCommit }) {
  const identity = iosReleaseIdentity(version);
  if (prerelease !== version.includes('-')) throw new Error('Release channel and iOS version disagree');
  validateNotice(notice, version);
  const contentByLocale = Object.fromEntries(LOCALES.map(locale => {
    const content = notice.contentByLocale[locale];
    if (content.intro.length > 8000 || content.topics.length > 30
      || content.topics.some(topic => topic.title.length > 500 || topic.text.length > 8000)) {
      throw new Error('iOS release notice exceeds client limits');
    }
    return [locale, { intro: content.intro, topics: content.topics.map(({ title, text }) => ({ title, text })) }];
  }));
  const metadata = validateIosMetadata(JSON.parse(fs.readFileSync(
    path.join(assets, identity.assetName.replace(/\.ipa$/, '.update.json')), 'utf8')), version);
  const ipa = path.join(assets, identity.assetName);
  if (metadata.size !== fs.statSync(ipa).size || metadata.sha256 !== await sha256File(ipa)
    || metadata.sourceCommit !== sourceCommit) throw new Error('iOS artifact does not match the published release');
  const manifest = { ...metadata,
    file: `https://github.com/Ciciy-l/lex/releases/download/v${version}/${identity.assetName}`,
    releaseUrl: `https://github.com/Ciciy-l/lex/releases/tag/v${version}`,
    contentByLocale };
  if (Buffer.byteLength(JSON.stringify(manifest, null, 2) + '\n') > 256 * 1024) throw new Error('iOS manifest exceeds client limits');
  return manifest;
}

export function publishIosManifest(manifest, destination) {
  validateIosMetadata(manifest, manifest.version);
  fs.mkdirSync(destination, { recursive: true });
  const writes = [];
  for (const suffix of manifest.version.includes('-') ? ['-beta'] : ['', '-beta']) {
    const file = path.join(destination, `manifest-ios${suffix}.json`);
    if (fs.existsSync(file)) {
      const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
      validateIosMetadata(previous, previous.version);
      const before = androidVersionCode(previous.version), after = androidVersionCode(manifest.version);
      if (before > after) continue;
      if (before === after && (previous.sha256 !== manifest.sha256 || previous.size !== manifest.size
        || previous.sourceCommit !== manifest.sourceCommit || previous.minimumOSVersion !== manifest.minimumOSVersion)) {
        throw new Error('Refusing to replace an iOS version with different bytes or identity');
      }
    }
    writes.push(file);
  }
  // Validate both pointers before changing either one. Git publishes them atomically.
  for (const file of writes) fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.REPOSITORY !== 'Ciciy-l/lex') throw new Error('Unexpected Lex release repository');
  if (!['true', 'false'].includes(process.env.RELEASE_PRERELEASE)) throw new Error('Missing release channel');
  const version = (process.env.RELEASE_TAG ?? '').replace(/^v/, '');
  iosReleaseIdentity(version);
  const manifest = await buildIosManifest({ version, assets: process.argv[2],
    notice: JSON.parse(fs.readFileSync(new URL(`../release-notices/${version}.json`, import.meta.url), 'utf8')),
    prerelease: process.env.RELEASE_PRERELEASE === 'true', sourceCommit: process.env.RELEASE_COMMIT });
  publishIosManifest(manifest, process.argv[3]);
}
