export type LexUpdateChannel = 'release' | 'beta';
export interface LexReleaseContent { intro: string; topics: { title: string; text: string }[] }
export interface LexApkManifest {
  schemaVersion: 1;
  platform: 'android';
  version: string;
  versionCode: number;
  packageName: 'io.github.ciciyl.lex';
  file: string;
  size: number;
  sha256: string;
  certificateSha256: string;
  releaseUrl: string;
  contentByLocale: Record<string, LexReleaseContent>;
}
export const LEX_RELEASE_ROOT = 'https://github.com/Ciciy-l/lex/releases';
export const LEX_APK_CHECK_INTERVAL = 6 * 60 * 60 * 1000;
export const LEX_APK_REMINDER_INTERVAL = 24 * 60 * 60 * 1000;

/** Mirrors the existing release versionCode allocation, never lexicographic comparison. */
export function lexAndroidVersionCode(version: string): number {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.([1-9]\d*))?$/.exec(version);
  if (!match) throw new Error('INVALID_METADATA');
  const [, major, minor, patch, channel, sequence] = match;
  if (+major > 20 || +minor > 99 || +patch > 9999 || (sequence && +sequence > 29)) throw new Error('INVALID_METADATA');
  const slot = channel ? ({ alpha: 0, beta: 30, rc: 60 }[channel]! + Number(sequence)) : 99;
  return +major * 100000000 + +minor * 1000000 + +patch * 100 + slot;
}

export function defaultLexUpdateChannel(version: string): LexUpdateChannel {
  return version.includes('-') ? 'beta' : 'release';
}

export function parseLexApkManifest(value: unknown, channel: LexUpdateChannel): LexApkManifest {
  if (!value || typeof value !== 'object') throw new Error('INVALID_METADATA');
  const m = value as LexApkManifest;
  if (m.schemaVersion !== 1 || m.platform !== 'android' || m.packageName !== 'io.github.ciciyl.lex'
    || typeof m.version !== 'string' || m.versionCode !== lexAndroidVersionCode(m.version)
    || (channel === 'release' && m.version.includes('-'))
    || m.file !== LEX_RELEASE_ROOT + '/download/v' + m.version + '/Lex-' + m.version + '-Android.apk'
    || m.releaseUrl !== LEX_RELEASE_ROOT + '/tag/v' + m.version
    || !Number.isSafeInteger(m.size) || m.size <= 0 || m.size > 8 * 1024 ** 3
    || typeof m.sha256 !== 'string' || typeof m.certificateSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(m.sha256) || !/^[a-f0-9]{64}$/.test(m.certificateSha256)) {
    throw new Error('INVALID_METADATA');
  }
  for (const locale of ['zh-CN', 'zh-TW', 'en', 'ja', 'ko']) {
    const content = m.contentByLocale?.[locale];
    if (!content || typeof content.intro !== 'string' || !content.intro.trim()
      || !Array.isArray(content.topics) || !content.topics.length
      || content.topics.some(topic => !topic || typeof topic.title !== 'string'
        || !topic.title.trim() || typeof topic.text !== 'string' || !topic.text.trim())) throw new Error('INVALID_METADATA');
  }
  return m;
}

export function lexApkNotes(manifest: LexApkManifest, locale: string): string {
  const content = manifest.contentByLocale[locale] ?? manifest.contentByLocale.en;
  return [content.intro, ...content.topics.map(topic => topic.title + '\n' + topic.text)].join('\n\n');
}
