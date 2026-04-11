import UIKit
import Flutter
import GoogleMaps

@main
@objc class AppDelegate: FlutterAppDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    // Initializing Google Maps with the shared API Key
    print("DEBUG: Registering Google Maps with key: AIzaSyAIupE9r7gG3XGcem6hlg_8Dosw5AOk9yc")
    GMSServices.provideAPIKey("AIzaSyAIupE9r7gG3XGcem6hlg_8Dosw5AOk9yc")
    
    GeneratedPluginRegistrant.register(with: self)
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
