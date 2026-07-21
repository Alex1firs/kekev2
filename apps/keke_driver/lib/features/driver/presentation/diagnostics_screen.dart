import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../../core/theme/app_theme.dart';
import '../../../core/services/driver_diagnostics.dart';
import '../../../core/services/oem_battery_service.dart';
import '../../../core/services/battery_optimization_service.dart';
import '../../../core/services/reliability_log.dart';
import '../../../core/storage/secure_storage.dart';

/// Field-support diagnostics: shows exactly why a driver is (or isn't)
/// operationally online and dispatch-eligible, plus the OEM battery fix and a
/// recent event log. Auto-refreshes every 3s.
class DiagnosticsScreen extends StatefulWidget {
  const DiagnosticsScreen({super.key});

  @override
  State<DiagnosticsScreen> createState() => _DiagnosticsScreenState();
}

class _DiagnosticsScreenState extends State<DiagnosticsScreen> {
  final _storage = SecureStorageService(const FlutterSecureStorage());
  DriverDiagnostics? _diag;
  OemGuidance? _oem;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _refresh();
    _timer = Timer.periodic(const Duration(seconds: 3), (_) => _refresh());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _refresh() async {
    final intent = await _storage.readOnlineIntent();
    final diag = await DriverDiagnostics.collect(onlineIntent: intent);
    final oem = await OemBatteryService.guidance();
    if (mounted) setState(() {
      _diag = diag;
      _oem = oem;
    });
  }

  @override
  Widget build(BuildContext context) {
    final d = _diag;
    return Scaffold(
      backgroundColor: AppColors.charcoal,
      appBar: AppBar(
        backgroundColor: AppColors.charcoal,
        foregroundColor: AppColors.white,
        title: const Text('Connection Diagnostics'),
      ),
      body: d == null
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _refresh,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  _verdictCard(d),
                  const SizedBox(height: 16),
                  _sectionTitle('Live status'),
                  _row('Online intention', d.onlineIntent ? 'On' : 'Off', d.onlineIntent),
                  _row('Background service running', _yn(d.serviceRunning), d.serviceRunning),
                  _row('Heartbeat', d.heartbeatFresh ? 'Fresh' : 'Stale',
                      d.heartbeatFresh,
                      sub: d.heartbeatAgeSeconds == null ? 'never' : '${d.heartbeatAgeSeconds}s ago'),
                  _row('Location', d.locationFresh ? 'Fresh' : 'Stale', d.locationFresh,
                      sub: d.locationAgeSeconds == null ? 'never' : '${d.locationAgeSeconds}s ago'),
                  _row('Dispatch eligible', _yn(d.dispatchEligible), d.dispatchEligible),
                  if (d.lastHeartbeatError != null)
                    _row('Last heartbeat error', d.lastHeartbeatError!, false),
                  const SizedBox(height: 16),
                  _sectionTitle('Permissions & device'),
                  _row('Location permission', _permText(d), d.backgroundLocationGranted),
                  _row('Background location (all the time)',
                      _yn(d.backgroundLocationGranted), d.backgroundLocationGranted),
                  _row('GPS enabled', _yn(d.locationServiceEnabled), d.locationServiceEnabled),
                  _row('Notifications allowed', _yn(d.notificationsGranted), d.notificationsGranted),
                  _row('Push token', d.fcmTokenPresent ? 'Active' : 'Missing', d.fcmTokenPresent),
                  _row('Network', d.online ? d.networkType : 'Offline', d.online),
                  _row('Battery optimized', d.batteryOptimized ? 'Restricted' : 'Unrestricted',
                      !d.batteryOptimized),
                  _row('Phone', '${d.oemName} · Android SDK ${d.androidSdk}', true),
                  _row('App version', d.appVersion, true),
                  const SizedBox(height: 20),
                  _batteryFixCard(d),
                  const SizedBox(height: 20),
                  _sectionTitle('Recent events'),
                  _logCard(),
                  const SizedBox(height: 24),
                ],
              ),
            ),
    );
  }

  Widget _verdictCard(DriverDiagnostics d) {
    final ok = d.dispatchEligible;
    final reason = d.blockingReason;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: ok ? AppColors.success : AppColors.error,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        children: [
          Icon(ok ? Icons.check_circle : Icons.error_outline, color: AppColors.white, size: 32),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(ok ? 'Online and ready for rides' : 'Not receiving rides',
                    style: AppTextStyles.title(color: AppColors.white)),
                if (!ok && reason != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text(reason, style: TextStyle(color: AppColors.white.withOpacity(0.9))),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _batteryFixCard(DriverDiagnostics d) {
    final needsFix = d.batteryOptimized || (d.aggressiveOem && d.batteryOptimized);
    final oem = _oem;
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.darkGray,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.battery_alert, color: AppColors.primary),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  needsFix
                      ? 'Your phone may stop KekeRide in the background'
                      : 'Background reliability',
                  style: AppTextStyles.title(color: AppColors.white),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            needsFix
                ? 'Allow unrestricted battery use so you can receive rides while your screen is locked.'
                : 'Battery is unrestricted. Keep it that way to stay online with the screen locked.',
            style: const TextStyle(color: AppColors.lightGray),
          ),
          if (oem != null) ...[
            const SizedBox(height: 12),
            Text('On your ${oem.manufacturer} (${oem.os}):',
                style: AppTextStyles.body(color: AppColors.white, weight: FontWeight.w600)),
            const SizedBox(height: 6),
            ...oem.steps.asMap().entries.map((e) => Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Text('${e.key + 1}. ${e.value}',
                      style: const TextStyle(color: AppColors.lightGray, fontSize: 13)),
                )),
          ],
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: ElevatedButton(
                  style: ElevatedButton.styleFrom(
                      backgroundColor: AppColors.primary, foregroundColor: AppColors.charcoal),
                  onPressed: () async {
                    await BatteryOptimizationService.requestExemption();
                    await _refresh();
                  },
                  child: const Text('Allow unrestricted'),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: OutlinedButton(
                  style: OutlinedButton.styleFrom(
                      foregroundColor: AppColors.white,
                      side: const BorderSide(color: AppColors.lightGray)),
                  onPressed: () async {
                    await OemBatteryService.openOemAutoStartSettings();
                  },
                  child: const Text('Auto-start settings'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _logCard() {
    final entries = ReliabilityLog.recent().take(40).toList();
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.black.withOpacity(0.4),
        borderRadius: BorderRadius.circular(10),
      ),
      child: entries.isEmpty
          ? const Text('No events yet.', style: TextStyle(color: AppColors.lightGray))
          : Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: entries.map((e) {
                final t = e.at;
                final ts =
                    '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}:${t.second.toString().padLeft(2, '0')}';
                final kv = e.fields.entries.map((f) => '${f.key}=${f.value}').join(' ');
                return Padding(
                  padding: const EdgeInsets.only(bottom: 3),
                  child: Text('$ts  ${e.event}${kv.isEmpty ? '' : '  $kv'}',
                      style: const TextStyle(
                          color: AppColors.paleGray, fontFamily: 'monospace', fontSize: 11)),
                );
              }).toList(),
            ),
    );
  }

  // ---- small helpers ----
  Widget _sectionTitle(String t) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Text(t, style: AppTextStyles.body(color: AppColors.lightGray, weight: FontWeight.w700)),
      );

  Widget _row(String label, String value, bool good, {String? sub}) => Container(
        margin: const EdgeInsets.only(bottom: 6),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(color: AppColors.darkGray, borderRadius: BorderRadius.circular(10)),
        child: Row(
          children: [
            Icon(good ? Icons.check_circle : Icons.cancel,
                color: good ? AppColors.success : AppColors.error, size: 18),
            const SizedBox(width: 10),
            Expanded(child: Text(label, style: const TextStyle(color: AppColors.white))),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(value,
                    style: TextStyle(
                        color: good ? AppColors.white : AppColors.lightGray,
                        fontWeight: FontWeight.w600)),
                if (sub != null) Text(sub, style: const TextStyle(color: AppColors.lightGray, fontSize: 11)),
              ],
            ),
          ],
        ),
      );

  String _yn(bool b) => b ? 'Yes' : 'No';
  String _permText(DriverDiagnostics d) {
    switch (d.locationPermission.name) {
      case 'always':
        return 'Allow all the time';
      case 'whileInUse':
        return 'While using app';
      case 'denied':
        return 'Denied';
      case 'deniedForever':
        return 'Denied (settings)';
      default:
        return d.locationPermission.name;
    }
  }
}
