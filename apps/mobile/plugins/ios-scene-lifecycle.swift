// AppDelegate.swift receives this source during Expo prebuild. Keep one React
// root and the existing Expo app delegate subscribers when adopting UIScene.
extension AppDelegate {
  func connectScene(_ windowScene: UIWindowScene, options: UIScene.ConnectionOptions) {
    if let window {
      window.windowScene = windowScene
      window.makeKeyAndVisible()
      return
    }
    var launchOptions = initialLaunchOptions ?? [:]
    initialLaunchOptions = nil
    if let context = options.urlContexts.first {
      launchOptions[.url] = context.url
      launchOptions[.sourceApplication] = context.options.sourceApplication
      launchOptions[.annotation] = context.options.annotation
    }
    if let activity = options.userActivities.first {
      launchOptions[.userActivityDictionary] = [
        "UIApplicationLaunchOptionsUserActivityTypeKey": activity.activityType,
        "UIApplicationLaunchOptionsUserActivityKey": activity
      ]
    }
    if let response = options.notificationResponse {
      launchOptions[.remoteNotification] = response.notification.request.content.userInfo
    }
    if let shortcut = options.shortcutItem {
      launchOptions[.shortcutItem] = shortcut
    }
    let sceneWindow = UIWindow(windowScene: windowScene)
    window = sceneWindow
    reactNativeFactory?.startReactNative(
      withModuleName: "main",
      in: sceneWindow,
      launchOptions: launchOptions)
  }
}

// UIKit routes lifecycle and URL callbacks to this delegate after scene
// adoption. Forward them through AppDelegate to retain Expo/RN integration.
class LexSceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?
  private var appDelegate: AppDelegate? { UIApplication.shared.delegate as? AppDelegate }

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
    guard let windowScene = scene as? UIWindowScene, let appDelegate else { return }
    // Seed Expo Linking before creating the React root. React Native receives
    // the same cold-start URL via launchOptions; no JS listener exists yet to
    // receive a duplicate event. A reconnected scene forwards to the live root.
    self.scene(scene, openURLContexts: options.urlContexts)
    for activity in options.userActivities { self.scene(scene, continue: activity) }
    appDelegate.connectScene(windowScene, options: options)
    window = appDelegate.window
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    appDelegate?.applicationDidBecomeActive(UIApplication.shared)
  }
  func sceneWillResignActive(_ scene: UIScene) {
    appDelegate?.applicationWillResignActive(UIApplication.shared)
  }
  func sceneWillEnterForeground(_ scene: UIScene) {
    appDelegate?.applicationWillEnterForeground(UIApplication.shared)
  }
  func sceneDidEnterBackground(_ scene: UIScene) {
    appDelegate?.applicationDidEnterBackground(UIApplication.shared)
  }

  func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
    for context in contexts {
      var options: [UIApplication.OpenURLOptionsKey: Any] = [.openInPlace: context.options.openInPlace]
      options[.sourceApplication] = context.options.sourceApplication
      options[.annotation] = context.options.annotation
      _ = appDelegate?.application(UIApplication.shared, open: context.url, options: options)
    }
  }
  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    _ = appDelegate?.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
  }
  func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
    guard let appDelegate else { completionHandler(false); return }
    appDelegate.application(UIApplication.shared, performActionFor: shortcutItem, completionHandler: completionHandler)
  }
}
