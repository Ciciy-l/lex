const { androidVersionCode } = require('./lex-mobile-config.cjs');

// Keep the existing mobile SemVer order, within Apple's 4.2.2 digit build format.
// A release is immutable: retrying it never invents a new build number.
// Offset the first component by one: Apple's CFBundleVersion cannot start at 0.
function iosReleaseIdentity(version) {
  const order = androidVersionCode(version);
  const [major, minor, patch] = version.split('-')[0].split('.').map(Number);
  if (patch > 99) throw new Error('Lex iOS requires patch <= 99 for CFBundleVersion');
  return { version, shortVersion: `${major}.${minor}.${patch}`,
    buildNumber: `${major * 100 + minor + 1}.${patch}.${order % 100}`,
    bundleIdentifier: 'io.github.ciciyl.lex',
    assetName: `Lex-${version}-iOS-unsigned.ipa` };
}

module.exports = { iosReleaseIdentity };
