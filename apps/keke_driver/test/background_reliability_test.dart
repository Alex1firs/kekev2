import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart';
import 'package:keke_driver/core/services/driver_diagnostics.dart';
import 'package:keke_driver/core/services/oem_battery_service.dart';

/// Pure-logic tests for the background-reliability subsystem. These don't touch
/// platform channels — they exercise the eligibility state machine and the OEM
/// guidance mapping, which is where the reasoning lives.

DriverDiagnostics _diag({
  bool onlineIntent = true,
  bool serviceRunning = true,
  int? hbAge = 5,
  int? locAge = 10,
  bool bgLoc = true,
  bool online = true,
  bool locEnabled = true,
  LocationPermission perm = LocationPermission.always,
  bool batteryOptimized = false,
  bool aggressive = false,
}) {
  return DriverDiagnostics(
    onlineIntent: onlineIntent,
    serviceRunning: serviceRunning,
    lastHeartbeatAt: null,
    heartbeatAgeSeconds: hbAge,
    lastLocationAt: null,
    locationAgeSeconds: locAge,
    lastHeartbeatError: null,
    batteryOptimized: batteryOptimized,
    aggressiveOem: aggressive,
    oemName: 'Test',
    locationPermission: perm,
    backgroundLocationGranted: bgLoc,
    locationServiceEnabled: locEnabled,
    notificationsGranted: true,
    fcmTokenPresent: true,
    online: online,
    networkType: 'wifi',
    appVersion: '1.0.0+1',
    androidSdk: 34,
  );
}

void main() {
  group('DriverDiagnostics eligibility state machine', () {
    test('all-good is dispatch-eligible with no blocking reason', () {
      final d = _diag();
      expect(d.heartbeatFresh, isTrue);
      expect(d.locationFresh, isTrue);
      expect(d.dispatchEligible, isTrue);
      expect(d.blockingReason, isNull);
    });

    test('offline intent blocks and is the reported reason', () {
      final d = _diag(onlineIntent: false);
      expect(d.dispatchEligible, isFalse);
      expect(d.blockingReason, contains('Offline'));
    });

    test('stale heartbeat (>45s) is not fresh and blocks', () {
      final d = _diag(hbAge: 60);
      expect(d.heartbeatFresh, isFalse);
      expect(d.dispatchEligible, isFalse);
      expect(d.blockingReason, contains('Heartbeat'));
    });

    test('missing heartbeat blocks', () {
      final d = _diag(hbAge: null);
      expect(d.heartbeatFresh, isFalse);
      expect(d.dispatchEligible, isFalse);
    });

    test('stale location (>90s) blocks', () {
      final d = _diag(locAge: 120);
      expect(d.locationFresh, isFalse);
      expect(d.dispatchEligible, isFalse);
      expect(d.blockingReason, contains('Location'));
    });

    test('missing background location blocks with the right reason', () {
      final d = _diag(bgLoc: false, perm: LocationPermission.whileInUse);
      expect(d.dispatchEligible, isFalse);
      expect(d.blockingReason, contains('Background location'));
    });

    test('no network blocks', () {
      final d = _diag(online: false);
      expect(d.dispatchEligible, isFalse);
      expect(d.blockingReason, contains('internet'));
    });

    test('service not running blocks', () {
      final d = _diag(serviceRunning: false);
      expect(d.dispatchEligible, isFalse);
      expect(d.blockingReason, contains('Background service'));
    });

    test('GPS off is reported before permission', () {
      final d = _diag(locEnabled: false);
      expect(d.blockingReason, contains('GPS'));
    });

    test('battery restriction surfaces only on aggressive OEM when otherwise ok', () {
      final d = _diag(batteryOptimized: true, aggressive: true);
      // Everything else is fine, so the battery restriction is the reason.
      expect(d.blockingReason, contains('Battery'));
    });
  });

  group('OEM guidance mapping', () {
    test('Transsion family is aggressive with auto-start steps', () {
      for (final m in ['TECNO', 'Infinix', 'itel']) {
        final g = OemBatteryService.guidanceForManufacturer(m);
        expect(g.aggressive, isTrue, reason: '$m should be aggressive');
        expect(g.steps.any((s) => s.toLowerCase().contains('auto-start') || s.toLowerCase().contains('autostart')), isTrue);
        expect(g.intents, isNotEmpty);
      }
    });

    test('Xiaomi/Oppo/Vivo/Samsung are recognized and aggressive', () {
      for (final m in ['Xiaomi', 'OPPO', 'vivo', 'samsung']) {
        final g = OemBatteryService.guidanceForManufacturer(m);
        expect(g.aggressive, isTrue, reason: '$m should be aggressive');
        expect(g.steps, isNotEmpty);
      }
    });

    test('unknown/stock manufacturer is non-aggressive with a safe default', () {
      final g = OemBatteryService.guidanceForManufacturer('Google');
      expect(g.aggressive, isFalse);
      expect(g.steps, isNotEmpty);
    });
  });
}
