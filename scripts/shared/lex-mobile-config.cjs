// Lex installation identity is independent from the selected Cindy service realm.
const ANDROID_PACKAGE = 'io.github.ciciyl.lex';

function androidVersionCode(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.([1-9]\d*))?$/.exec(version);
  if (!match) throw new Error('Lex mobile requires major.minor.patch or -alpha.N / -beta.N / -rc.N');
  const [, major, minor, patch, channel, sequence] = match;
  if (+major > 20 || +minor > 99 || +patch > 9999 || (sequence && +sequence > 29)) {
    throw new Error('Lex mobile version exceeds Android versionCode allocation');
  }
  const slot = channel ? { alpha: 0, beta: 30, rc: 60 }[channel] + +sequence : 99;
  return +major * 100000000 + +minor * 1000000 + +patch * 100 + slot;
}

function lexMobileConfig(config, env = process.env) {
  if (env.LEX_MOBILE_BUILD !== '1') return config;
  if (env.EXPO_PUBLIC_XDT_OTA_SELFHOST === '1' || env.EAS_PROJECT_ID || env.EAS_OWNER || env.CINDY_USE_LOCAL_REGION_CONFIG === '1') {
    throw new Error('Lex APK releases cannot inherit Cindy/EAS/self-host update configuration');
  }
  const version = env.LEX_MOBILE_VERSION || '';
  const versionCode = androidVersionCode(version);
  const icon = '../desktop/resources/icon-master-1024.png';
  return {
    ...config,
    name: 'Lex',
    slug: 'lex-mobile',
    version,
    icon,
    // Preserve Cindy callback/deep-link compatibility. Package/data identity is Lex.
    // Changing OAuth schemes requires an independently registered server contract.
    android: { ...config.android, package: ANDROID_PACKAGE, versionCode, adaptiveIcon: { foregroundImage: icon, backgroundColor: '#ffffff' } },
    ios: { ...config.ios, bundleIdentifier: ANDROID_PACKAGE, buildNumber: String(versionCode) },
    updates: { enabled: false },
    plugins: config.plugins.map((plugin) => {
      if (Array.isArray(plugin) && plugin[0] === 'expo-splash-screen') {
        return [plugin[0], { backgroundColor: '#ffffff', image: icon, imageWidth: 128, dark: { backgroundColor: '#262626', image: icon } }];
      }
      return plugin;
    }),
  };
}

module.exports = { ANDROID_PACKAGE, androidVersionCode, lexMobileConfig };
