// The key store, the prefs, the private folder, the clipboard, the
// screen's cover, the app's version, notifications, join links and the
// subscription, registered on the app's Flutter engine; told of the APNs
// token as the app's delegate, and of links opened as the scene's.
import Flutter

public final class PircPlatformPlugin: NSObject, FlutterPlugin, FlutterSceneLifeCycleDelegate {
  // Kept here: Flutter holds an application delegate only weakly, and
  // notifications' channel lives with it.
  private static var registered: [PircPlatformPlugin] = []
  private var push: Push?
  private var screen: Screen?
  private var links: Links?
  private var store: Store?

  public static func register(with registrar: FlutterPluginRegistrar) {
    KeyStore.register(with: registrar.messenger())
    Prefs.register(with: registrar.messenger())
    Files.register(with: registrar.messenger())
    Clipboard.register(with: registrar.messenger())
    About.register(with: registrar.messenger())
    let plugin = PircPlatformPlugin()
    plugin.screen = Screen.register(with: registrar.messenger())
    plugin.push = Push(channel: FlutterMethodChannel(name: "dev.pirc.app/push", binaryMessenger: registrar.messenger()))
    plugin.links = Links(channel: FlutterMethodChannel(name: "dev.pirc.app/links", binaryMessenger: registrar.messenger()))
    plugin.store = Store(channel: FlutterMethodChannel(name: "dev.pirc.app/store", binaryMessenger: registrar.messenger()))
    registered.append(plugin)
    registrar.addApplicationDelegate(plugin)
    registrar.addSceneDelegate(plugin)
  }

  public func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    push?.registered(deviceToken)
  }

  public func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
    push?.failed(error)
  }

  // Started by a link.
  public func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions?) -> Bool {
    links?.open(connectionOptions?.urlContexts.map(\.url) ?? []) ?? false
  }

  // A link while the app runs.
  public func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) -> Bool {
    links?.open(URLContexts.map(\.url)) ?? false
  }
}
