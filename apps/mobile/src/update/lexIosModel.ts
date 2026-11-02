import { lexAndroidVersionCode, LEX_RELEASE_ROOT, type LexReleaseContent, type LexUpdateChannel } from './lexApkModel';

export const LEX_IOS_INSTALL_HELP = 'https://github.com/Ciciy-l/lex/blob/main/docs/lex-ios-distribution.md';
export interface LexIosManifest {
  schemaVersion: 1; platform: 'ios'; signing: 'unsigned'; version: string;
  shortVersion: string; buildNumber: string; bundleIdentifier: 'io.github.ciciyl.lex';
  minimumOSVersion: string; file: string; releaseUrl: string; size: number; sha256: string;
  sourceCommit: string; sourceDirty: false; contentByLocale: Record<string, LexReleaseContent>;
}
export function iosBuildNumber(version: string): string {
  const order = lexAndroidVersionCode(version);
  const [major, minor, patch] = version.split('-')[0].split('.').map(Number);
  if (patch > 99) throw new Error('INVALID_METADATA');
  return [major * 100 + minor + 1, patch, order % 100].join('.');
}
export function compareNumericVersion(left: string, right: string): number {
  if (!/^\d+(?:\.\d+){0,2}$/.test(left) || !/^\d+(?:\.\d+){0,2}$/.test(right)) throw new Error('INVALID_METADATA');
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] ?? 0) !== (b[i] ?? 0)) return Math.sign((a[i] ?? 0) - (b[i] ?? 0)); }
  return 0;
}
export function parseLexIosManifest(value: unknown, channel: LexUpdateChannel): LexIosManifest {
  if (!value || typeof value !== 'object') throw new Error('INVALID_METADATA');
  const m = value as LexIosManifest;
  if (m.schemaVersion !== 1 || m.platform !== 'ios' || m.signing !== 'unsigned'
    || m.sourceDirty !== false
    || m.bundleIdentifier !== 'io.github.ciciyl.lex' || typeof m.version !== 'string'
    || m.buildNumber !== iosBuildNumber(m.version) || m.shortVersion !== m.version.split('-')[0]
    || (channel === 'release' && m.version.includes('-'))
    || typeof m.minimumOSVersion !== 'string' || !/^[1-9]\d?\.\d{1,2}(?:\.\d{1,2})?$/.test(m.minimumOSVersion)
    || m.file !== LEX_RELEASE_ROOT + '/download/v' + m.version + '/Lex-' + m.version + '-iOS-unsigned.ipa'
    || m.releaseUrl !== LEX_RELEASE_ROOT + '/tag/v' + m.version
    || !Number.isSafeInteger(m.size) || m.size <= 0 || m.size > 8 * 1024 ** 3
    || typeof m.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(m.sha256)
    || typeof m.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(m.sourceCommit)) throw new Error('INVALID_METADATA');
  for (const locale of ['zh-CN', 'zh-TW', 'en', 'ja', 'ko']) {
    const content = m.contentByLocale?.[locale];
    if (!content || typeof content.intro !== 'string' || !content.intro.trim() || content.intro.length > 8000
      || !Array.isArray(content.topics) || !content.topics.length || content.topics.length > 30
      || content.topics.some(topic => !topic || typeof topic.title !== 'string' || !topic.title.trim()
        || topic.title.length > 500 || typeof topic.text !== 'string' || !topic.text.trim() || topic.text.length > 8000)) {
      throw new Error('INVALID_METADATA');
    }
  }
  return m;
}
export function isNewerIosRelease(target: LexIosManifest, version: string, build: string): boolean {
  const difference = lexAndroidVersionCode(target.version) - lexAndroidVersionCode(version);
  return difference > 0 || (difference === 0 && compareNumericVersion(target.buildNumber, build) > 0);
}
