import 'dart:io';
import 'package:android_intent_plus/android_intent.dart';
import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'reliability_log.dart';

/// OEM-specific background-reliability guidance.
///
/// The standard Android battery-optimization exemption
/// (REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, handled by
/// [BatteryOptimizationService]) is NECESSARY but on several manufacturers —
/// especially Transsion (Tecno/Infinix/itel), which dominate the Nigerian
/// market, plus Xiaomi/Oppo/Vivo — it is NOT SUFFICIENT. Those OEMs run a second
/// proprietary power manager ("Protected apps", "Auto-launch", "Startup
/// manager") that kills foreground services ~1 minute after screen-off unless
/// the app is explicitly whitelisted there.
///
/// This service (1) detects the manufacturer, (2) supplies device-appropriate
/// step-by-step instructions, and (3) where feasible fires the OEM's own
/// auto-start/protected-app settings intent so the driver lands on the exact
/// screen instead of hunting through menus.
class OemBatteryService {
  static final DeviceInfoPlugin _deviceInfo = DeviceInfoPlugin();
  static OemGuidance? _cached;

  /// Manufacturer string (lowercased), e.g. "tecno", "infinix", "xiaomi".
  static Future<String> manufacturer() async {
    if (!Platform.isAndroid) return 'unknown';
    try {
      final info = await _deviceInfo.androidInfo;
      return info.manufacturer.toLowerCase().trim();
    } catch (_) {
      return 'unknown';
    }
  }

  /// Android API level (e.g. 34 for Android 14).
  static Future<int> androidSdk() async {
    if (!Platform.isAndroid) return 0;
    try {
      final info = await _deviceInfo.androidInfo;
      return info.version.sdkInt;
    } catch (_) {
      return 0;
    }
  }

  /// Device-appropriate guidance (cached after first lookup).
  static Future<OemGuidance> guidance() async {
    if (_cached != null) return _cached!;
    final mfr = await manufacturer();
    _cached = _forManufacturer(mfr);
    return _cached!;
  }

  /// True on OEMs known to aggressively kill background services beyond the
  /// stock battery-optimization exemption — i.e. the driver almost certainly
  /// needs the extra protected-app/auto-start step.
  static Future<bool> isAggressiveOem() async {
    final g = await guidance();
    return g.aggressive;
  }

  /// Try to open the OEM's proprietary auto-start / protected-app screen. Falls
  /// back to the app's own system settings if the OEM intent is unavailable.
  static Future<bool> openOemAutoStartSettings() async {
    if (!Platform.isAndroid) return false;
    final g = await guidance();
    for (final target in g.intents) {
      try {
        final AndroidIntent intent;
        if (target.action == 'action_application_details_settings') {
          // App's own details/settings page (reliable everywhere).
          intent = AndroidIntent(
            action: 'action_application_details_settings',
            data: 'package:${target.package}',
          );
        } else if (target.component.isNotEmpty) {
          // A specific OEM auto-start / protected-app activity.
          intent = AndroidIntent(
            action: 'android.intent.action.MAIN',
            componentName: target.component,
            package: target.package,
          );
        } else {
          continue; // nothing actionable for this target
        }
        await intent.launch();
        ReliabilityLog.log('oem_autostart_opened', {'target': target.label});
        return true;
      } catch (_) {
        // Try the next candidate (activity may not exist on this OS version).
      }
    }
    // Last-resort fallback: the app's own details page, where "Auto-launch" /
    // "Battery" live on most skins.
    try {
      await FlutterForegroundTask.openIgnoreBatteryOptimizationSettings();
      return true;
    } catch (_) {
      return false;
    }
  }

  /// Pure manufacturer→guidance mapping (exposed for tests; no platform calls).
  static OemGuidance guidanceForManufacturer(String mfr) => _forManufacturer(mfr.toLowerCase().trim());

  static OemGuidance _forManufacturer(String mfr) {
    // Transsion family — Tecno (HiOS), Infinix (XOS), itel (itel OS). Same
    // underlying power manager; the "Autostart"/"Auto-launch" toggle is the key.
    if (mfr.contains('tecno')) {
      return OemGuidance(
        manufacturer: 'Tecno',
        os: 'HiOS',
        aggressive: true,
        steps: const [
          'Open Phone Master (or Settings).',
          'Go to "App management" → "Auto-start" (or "Autostart management").',
          'Turn ON auto-start for KekeRide Driver.',
          'Back in Settings → Battery → let KekeRide "Run in background" / set to "No restrictions".',
          'Settings → Apps → KekeRide → Battery → "Unrestricted".',
        ],
        intents: _transsionIntents('ng.kekeride.driver'),
      );
    }
    if (mfr.contains('infinix')) {
      return OemGuidance(
        manufacturer: 'Infinix',
        os: 'XOS',
        aggressive: true,
        steps: const [
          'Open Phone Master / Settings.',
          'Go to "App management" → "Auto-start" (Autostart management).',
          'Turn ON auto-start for KekeRide Driver.',
          'Settings → Battery → "Background freeze" / "Power-intensive apps" → allow KekeRide.',
          'Settings → Apps → KekeRide → Battery → "No restrictions".',
        ],
        intents: _transsionIntents('ng.kekeride.driver'),
      );
    }
    if (mfr.contains('itel')) {
      return OemGuidance(
        manufacturer: 'itel',
        os: 'itel OS',
        aggressive: true,
        steps: const [
          'Open Settings → App management (or Phone Master).',
          'Find "Auto-start" / "Autostart" and enable it for KekeRide Driver.',
          'Settings → Battery → allow KekeRide to run in background.',
          'Settings → Apps → KekeRide → Battery → "Unrestricted".',
        ],
        intents: _transsionIntents('ng.kekeride.driver'),
      );
    }
    if (mfr.contains('xiaomi') || mfr.contains('redmi') || mfr.contains('poco')) {
      return OemGuidance(
        manufacturer: 'Xiaomi',
        os: 'MIUI / HyperOS',
        aggressive: true,
        steps: const [
          'Settings → Apps → Manage apps → KekeRide Driver.',
          'Enable "Autostart".',
          'On the same page open "Battery saver" → set to "No restrictions".',
          'Recent apps: swipe down on the KekeRide card → tap the lock icon so the system won\'t clear it.',
        ],
        intents: [
          const OemIntentTarget(
            label: 'MIUI autostart',
            package: 'com.miui.securitycenter',
            component: 'com.miui.securitycenter/com.miui.permcenter.autostart.AutoStartManagementActivity',
            action: 'main',
          ),
        ],
      );
    }
    if (mfr.contains('oppo') || mfr.contains('realme')) {
      return OemGuidance(
        manufacturer: 'Oppo',
        os: 'ColorOS',
        aggressive: true,
        steps: const [
          'Settings → Battery → "App battery management" → KekeRide → allow background running.',
          'Settings → Apps → KekeRide → enable "Allow auto launch".',
          'Recent apps: lock the KekeRide card so it isn\'t cleared.',
        ],
        intents: [
          const OemIntentTarget(
            label: 'ColorOS startup manager',
            package: 'com.coloros.safecenter',
            component: 'com.coloros.safecenter/com.coloros.safecenter.startupapp.StartupAppListActivity',
            action: 'main',
          ),
        ],
      );
    }
    if (mfr.contains('vivo') || mfr.contains('iqoo')) {
      return OemGuidance(
        manufacturer: 'Vivo',
        os: 'Funtouch OS / OriginOS',
        aggressive: true,
        steps: const [
          'Settings → Battery → "Background power consumption management" → KekeRide → allow.',
          'Settings → Apps → KekeRide → enable "Auto-start".',
          'i Manager → App manager → Autostart manager → enable KekeRide.',
        ],
        intents: [
          const OemIntentTarget(
            label: 'Vivo autostart',
            package: 'com.vivo.permissionmanager',
            component: 'com.vivo.permissionmanager/.activity.BgStartUpManagerActivity',
            action: 'main',
          ),
        ],
      );
    }
    if (mfr.contains('samsung')) {
      return OemGuidance(
        manufacturer: 'Samsung',
        os: 'One UI',
        aggressive: true,
        steps: const [
          'Settings → Apps → KekeRide Driver → Battery → set to "Unrestricted".',
          'Settings → Battery → "Background usage limits" → make sure KekeRide is NOT in "Sleeping"/"Deep sleeping" apps; add it to "Never sleeping apps".',
        ],
        intents: const [
          OemIntentTarget(
            label: 'App details',
            package: 'ng.kekeride.driver',
            component: '',
            action: 'action_application_details_settings',
          ),
        ],
      );
    }
    if (mfr.contains('huawei') || mfr.contains('honor')) {
      return OemGuidance(
        manufacturer: mfr.contains('honor') ? 'Honor' : 'Huawei',
        os: 'EMUI / MagicOS',
        aggressive: true,
        steps: const [
          'Settings → Apps → KekeRide → "App launch" → turn OFF "Manage automatically" and enable Auto-launch + Run in background.',
          'Settings → Battery → set KekeRide to not be optimized.',
        ],
        intents: const [
          OemIntentTarget(
            label: 'App details',
            package: 'ng.kekeride.driver',
            component: '',
            action: 'action_application_details_settings',
          ),
        ],
      );
    }
    // Stock Android / Pixel / others: the standard battery-optimization
    // exemption is normally enough.
    return OemGuidance(
      manufacturer: mfr.isEmpty ? 'your phone' : mfr,
      os: 'Android',
      aggressive: false,
      steps: const [
        'Settings → Apps → KekeRide Driver → Battery → "Unrestricted".',
        'Allow "Allow background activity" if prompted.',
      ],
      intents: const [
        OemIntentTarget(
          label: 'App details',
          package: 'ng.kekeride.driver',
          component: '',
          action: 'action_application_details_settings',
        ),
      ],
    );
  }

  static List<OemIntentTarget> _transsionIntents(String pkg) => [
        // Transsion (HiOS/XOS) background-app / autostart activities vary across
        // versions; try the common ones, then fall back to app details.
        const OemIntentTarget(
          label: 'Transsion background manager',
          package: 'com.transsion.phonemaster',
          component: 'com.transsion.phonemaster/com.cyin.himgr.autostart.AutoStartActivity',
          action: 'main',
        ),
        const OemIntentTarget(
          label: 'Transsion power',
          package: 'com.transsion.powermanager',
          component: '',
          action: 'main',
        ),
        OemIntentTarget(
          label: 'App details',
          package: pkg,
          component: '',
          action: 'action_application_details_settings',
        ),
      ];
}

class OemGuidance {
  final String manufacturer;
  final String os;

  /// True when this OEM needs the extra protected-app/auto-start step beyond the
  /// stock battery-optimization exemption.
  final bool aggressive;
  final List<String> steps;
  final List<OemIntentTarget> intents;
  const OemGuidance({
    required this.manufacturer,
    required this.os,
    required this.aggressive,
    required this.steps,
    required this.intents,
  });
}

class OemIntentTarget {
  final String label;
  final String package;
  final String component; // "" if not targeting a specific activity
  final String action; // 'main' or 'action_application_details_settings'
  const OemIntentTarget({
    required this.label,
    required this.package,
    required this.component,
    required this.action,
  });
}
