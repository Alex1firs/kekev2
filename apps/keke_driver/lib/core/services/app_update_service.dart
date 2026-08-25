import 'dart:io';

import 'package:dio/dio.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import 'reliability_log.dart';

/// The server's verdict on this installation.
class AppUpdateStatus {
  const AppUpdateStatus({
    required this.updateAvailable,
    required this.updateRequired,
    required this.latestVersion,
    required this.message,
    required this.storeUrl,
  });

  final bool updateAvailable;
  final bool updateRequired;
  final String latestVersion;
  final String message;
  final String storeUrl;

  static const none = AppUpdateStatus(
    updateAvailable: false, updateRequired: false,
    latestVersion: '', message: '', storeUrl: '',
  );
}

/// Asks the server whether this build is current.
///
/// ── Why the server decides ──────────────────────────────────────────────
/// The app cannot know what is on the store, and hard-coding a version would
/// mean shipping a release to announce a release. The server holds the policy,
/// so a fix can be announced — or, rarely, required — without another build.
///
/// ── Why it fails silently ───────────────────────────────────────────────
/// Every failure path here returns "no update". A driver must never be stopped
/// from working because a version check timed out on bad signal; the cost of
/// missing a prompt is one delayed update, and the cost of getting it wrong is
/// a driver locked out of a shift.
class AppUpdateService {
  AppUpdateService(this._dio);

  final Dio _dio;

  /// Don't ask on every resume — a driver switching apps at a junction should
  /// not generate a request each time.
  static const _minInterval = Duration(hours: 6);
  DateTime? _lastCheck;

  /// Dismissed prompts stay dismissed until the next launch, so "Later" means
  /// later rather than "again in ten seconds". A REQUIRED update ignores this.
  bool _dismissedThisSession = false;

  void markDismissed() => _dismissedThisSession = true;

  Future<AppUpdateStatus> check({bool force = false}) async {
    if (!force && _lastCheck != null &&
        DateTime.now().difference(_lastCheck!) < _minInterval) {
      return AppUpdateStatus.none;
    }
    _lastCheck = DateTime.now();

    try {
      final info = await PackageInfo.fromPlatform();
      final build = int.tryParse(info.buildNumber);
      final platform = Platform.isIOS ? 'ios' : 'android';

      final res = await _dio.get(
        '/drivers/app-release',
        queryParameters: {'platform': platform, if (build != null) 'build': build},
        options: Options(
          // Short: this is never worth delaying a screen for.
          receiveTimeout: const Duration(seconds: 6),
          sendTimeout: const Duration(seconds: 6),
        ),
      );

      final d = res.data;
      if (d is! Map) return AppUpdateStatus.none;

      final status = AppUpdateStatus(
        updateAvailable: d['updateAvailable'] == true,
        updateRequired: d['updateRequired'] == true,
        latestVersion: d['latestVersion']?.toString() ?? '',
        message: d['message']?.toString() ?? '',
        storeUrl: d['storeUrl']?.toString() ?? '',
      );

      ReliabilityLog.log('update_check', {
        'build': build,
        'available': status.updateAvailable,
        'required': status.updateRequired,
      });

      // A required update overrides a dismissal — the driver cannot work on
      // this build, so "Later" is not an option we can honour.
      if (status.updateRequired) _dismissedThisSession = false;
      if (_dismissedThisSession && !status.updateRequired) return AppUpdateStatus.none;

      return status;
    } catch (e) {
      ReliabilityLog.log('update_check_failed', {'reason': e.runtimeType.toString()});
      return AppUpdateStatus.none;
    }
  }

  /// Open the store listing.
  ///
  /// Returns false when there is nowhere to send them — an iOS build before
  /// the App Store listing exists, for instance. The caller keeps the dialog
  /// up rather than appearing to do nothing.
  Future<bool> openStore(String storeUrl) async {
    if (storeUrl.isEmpty) return false;
    try {
      final uri = Uri.parse(storeUrl);
      return await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (e) {
      ReliabilityLog.log('update_store_open_failed', {'reason': e.runtimeType.toString()});
      return false;
    }
  }
}
