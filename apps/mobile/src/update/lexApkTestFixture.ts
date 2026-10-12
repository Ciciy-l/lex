import { lexAndroidVersionCode } from './lexApkModel';

export function manifestFixture(version = '0.1.5-rc.1') {
  return {
    schemaVersion: 1, platform: 'android', version, versionCode: lexAndroidVersionCode(version),
    packageName: 'io.github.ciciyl.lex', size: 1024, sha256: 'a'.repeat(64), certificateSha256: 'b'.repeat(64),
    file: 'https://github.com/Ciciy-l/lex/releases/download/v' + version + '/Lex-' + version + '-Android.apk',
    releaseUrl: 'https://github.com/Ciciy-l/lex/releases/tag/v' + version,
    contentByLocale: Object.fromEntries(['zh-CN', 'zh-TW', 'en', 'ja', 'ko'].map(locale => [locale, {
      intro: 'Lex ' + locale, topics: [{ title: 'Update', text: 'Details' }],
    }])),
  };
}
