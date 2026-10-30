const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { withAppDelegate, withInfoPlist } = require('@expo/config-plugins');

const sceneSource = readFileSync(join(__dirname, 'ios-scene-lifecycle.swift'), 'utf8');
const marker = '// Lex single-scene lifecycle';
const windowStart = [
  '#if os(iOS) || os(tvOS)',
  '    window = UIWindow(frame: UIScreen.main.bounds)',
  '    factory.startReactNative(',
  '      withModuleName: "main",',
  '      in: window,',
  '      launchOptions: launchOptions)',
  '#endif',
].join('\n');

// Expo 57 still creates its window in AppDelegate; iOS 27 requires UIScene.
// Keep the factory and subscribers, moving only root creation into the scene.
function applySceneLifecycle(source) {
  if (source.includes(marker)) return source.slice(0, source.indexOf(marker)) + marker + '\n' + sceneSource;
  if (!source.includes(windowStart) || !source.includes('  var window: UIWindow?')) {
    throw new Error('Lex UIScene adapter: Expo AppDelegate template changed; review lifecycle integration before building.');
  }
  return source
    .replace('  var window: UIWindow?', '  var window: UIWindow?\n  var initialLaunchOptions: [UIApplication.LaunchOptionsKey: Any]?')
    .replace(windowStart, '    initialLaunchOptions = launchOptions')
    + '\n' + marker + '\n' + sceneSource;
}

function applySceneManifest(infoPlist) {
  const existing = infoPlist.UIApplicationSceneManifest ?? {};
  infoPlist.UIApplicationSceneManifest = {
    ...existing,
    UIApplicationSupportsMultipleScenes: false,
    UISceneConfigurations: {
      ...existing.UISceneConfigurations,
      UIWindowSceneSessionRoleApplication: [{
        UISceneConfigurationName: 'Lex',
        UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).LexSceneDelegate',
      }],
    },
  };
  return infoPlist;
}

function withIosSceneLifecycle(config) {
  config = withInfoPlist(config, (result) => {
    result.modResults = applySceneManifest(result.modResults);
    return result;
  });
  return withAppDelegate(config, (result) => {
    if (result.modResults.language !== 'swift') throw new Error('Lex UIScene adapter requires a Swift AppDelegate.');
    result.modResults.contents = applySceneLifecycle(result.modResults.contents);
    return result;
  });
}

module.exports = withIosSceneLifecycle;
module.exports.applySceneLifecycle = applySceneLifecycle;
module.exports.applySceneManifest = applySceneManifest;
// Include the copied native source in the resolved plugin input/fingerprint.
module.exports.sourceHash = createHash('sha256').update(sceneSource).digest('hex');
