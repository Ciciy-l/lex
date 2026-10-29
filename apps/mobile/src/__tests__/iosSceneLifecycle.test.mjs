import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applySceneLifecycle, applySceneManifest, sourceHash } = require('../../plugins/with-ios-scene-lifecycle');
const { lexMobileConfig } = require('../../../../scripts/shared/lex-mobile-config.cjs');

// The Expo 57 window block; prebuild must reject a changed upstream template
// instead of generating an app with two roots or a scene without a window.
const original = [
  'class AppDelegate: ExpoAppDelegate {',
  '  var window: UIWindow?',
  '  func launch() {',
  '    reactNativeFactory = factory',
  '#if os(iOS) || os(tvOS)',
  '    window = UIWindow(frame: UIScreen.main.bounds)',
  '    factory.startReactNative(',
  '      withModuleName: "main",',
  '      in: window,',
  '      launchOptions: launchOptions)',
  '#endif',
  '    return super.application(application, didFinishLaunchingWithOptions: launchOptions)',
  '  }',
  '  // existing URL / universal-link methods remain here',
  '}',
].join('\n');

describe('Lex iOS scene lifecycle', () => {
  it('moves window creation to the scene while retaining Expo initialization', () => {
    const result = applySceneLifecycle(original);
    expect(result).not.toContain('UIWindow(frame: UIScreen.main.bounds)');
    expect(result).toContain('initialLaunchOptions = launchOptions');
    expect(result).toContain('return super.application(application, didFinishLaunchingWithOptions: launchOptions)');
    expect(result).toContain('// existing URL / universal-link methods remain here');
    expect(result).toContain('UIWindow(windowScene: windowScene)');
    expect(result.match(/startReactNative\(/g)).toHaveLength(1);
    expect(result).toContain('launchOptions[.url] = context.url');
    expect(result).toContain('UIApplicationLaunchOptionsUserActivityKey');
    expect(result).toContain('appDelegate?.applicationDidEnterBackground(UIApplication.shared)');
    expect(result).toContain('appDelegate?.application(UIApplication.shared, open: context.url, options: options)');
    expect(result.indexOf('self.scene(scene, openURLContexts: options.urlContexts)'))
      .toBeLessThan(result.indexOf('appDelegate.connectScene(windowScene, options: options)'));
  });

  it('repeated prebuild is idempotent and refreshes copied native source', () => {
    const result = applySceneLifecycle(original);
    expect(applySceneLifecycle(result)).toBe(result);
    const stale = result.replace('class LexSceneDelegate:', 'class StaleSceneDelegate:');
    expect(applySceneLifecycle(stale)).toBe(result);
  });

  it('rejects a changed Expo window template', () => {
    expect(() => applySceneLifecycle(original.replace('in: window,', 'in: otherWindow,'))).toThrow('template changed');
  });

  it('declares one app scene without erasing unrelated plist/scene settings', () => {
    const result = applySceneManifest({
      OtherKey: true,
      UIApplicationSceneManifest: { UISceneConfigurations: { ExternalRole: [{ Existing: true }] } },
    });
    expect(result).toMatchObject({
      OtherKey: true,
      UIApplicationSceneManifest: {
        UIApplicationSupportsMultipleScenes: false,
        UISceneConfigurations: {
          ExternalRole: [{ Existing: true }],
          UIWindowSceneSessionRoleApplication: [{ UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).LexSceneDelegate' }],
        },
      },
    });
  });

  it('opts in only Lex builds and fingerprints the native source', () => {
    const base = { plugins: [], ios: {}, android: {} };
    expect(lexMobileConfig(base, {})).toBe(base);
    expect(sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(lexMobileConfig(base, { LEX_MOBILE_BUILD: '1', LEX_MOBILE_VERSION: '0.0.0' }).plugins)
      .toContainEqual(['./plugins/with-ios-scene-lifecycle', { sourceHash }]);
  });
});
