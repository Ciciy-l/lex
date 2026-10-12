import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ANDROID_PACKAGE, androidVersionCode } from './shared/lex-mobile-config.cjs';
import { validateNotice } from './lex-release-notices.mjs';

export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function buildAndroidManifest({ version, assets, notice, certificateSha256, prerelease }) {
  const code = androidVersionCode(version);
  if (prerelease !== version.includes('-')) throw new Error('Release channel and Android version disagree');
  validateNotice(notice, version);
  const name = 'Lex-' + version + '-Android';
  const metadata = JSON.parse(fs.readFileSync(path.join(assets, name + '.update.json'), 'utf8'));
  const apk = path.join(assets, name + '.apk');
  if (!/^[a-f0-9]{64}$/i.test(certificateSha256 ?? '')) throw new Error('Missing pinned Android certificate');
  if (metadata.schemaVersion !== 1 || metadata.version !== version || metadata.versionCode !== code
    || metadata.packageName !== ANDROID_PACKAGE || metadata.certificateSha256 !== certificateSha256.toLowerCase()
    || metadata.size !== fs.statSync(apk).size || metadata.sha256 !== await sha256File(apk)) {
    throw new Error('Android artifact metadata does not match the signed release');
  }
  return {
    ...metadata, platform: 'android',
    file: 'https://github.com/Ciciy-l/lex/releases/download/v' + version + '/' + name + '.apk',
    releaseUrl: 'https://github.com/Ciciy-l/lex/releases/tag/v' + version,
    contentByLocale: notice.contentByLocale,
  };
}

/** Never replace a newer pointer, including a newer RC when publishing a stable backport. */
export function publishAndroidManifest(manifest, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const suffixes = manifest.version.includes('-') ? ['-beta'] : ['', '-beta'];
  for (const suffix of suffixes) {
    const file = path.join(destination, 'manifest-android' + suffix + '.json');
    if (fs.existsSync(file)) {
      const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Number.isSafeInteger(previous.versionCode)) throw new Error('Invalid existing Android channel');
      if (previous.versionCode > manifest.versionCode) continue;
      if (previous.versionCode === manifest.versionCode && previous.sha256 !== manifest.sha256) {
        throw new Error('Refusing to replace an Android version with different bytes');
      }
    }
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = (process.env.RELEASE_TAG ?? '').replace(/^v/, '');
  androidVersionCode(version);
  if (process.env.REPOSITORY !== 'Ciciy-l/lex') throw new Error('Unexpected Lex release repository');
  const manifest = await buildAndroidManifest({ version,
    assets: process.argv[2],
    notice: JSON.parse(fs.readFileSync(new URL('../release-notices/' + version + '.json', import.meta.url), 'utf8')),
    certificateSha256: process.env.LEX_ANDROID_CERT_SHA256,
    prerelease: process.env.RELEASE_PRERELEASE === 'true',
  });
  publishAndroidManifest(manifest, process.argv[3]);
}
