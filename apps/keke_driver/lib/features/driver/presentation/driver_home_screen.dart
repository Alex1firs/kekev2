import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:geolocator/geolocator.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../../core/services/battery_optimization_service.dart';
import '../../../../core/network/socket_provider.dart';
import '../../auth/application/auth_controller.dart';
import '../application/driver_controller.dart';
import '../domain/driver_profile.dart';
import '../domain/driver_state.dart';
import 'driver_profile_screen.dart';
import 'earnings_screen.dart';
import 'widgets/battery_optimization_sheet.dart';
import 'widgets/incoming_request_card.dart';
import 'widgets/trip_operation_hud.dart';

class DriverHomeScreen extends ConsumerStatefulWidget {
  const DriverHomeScreen({super.key});

  @override
  ConsumerState<DriverHomeScreen> createState() => _DriverHomeScreenState();
}

class _DriverHomeScreenState extends ConsumerState<DriverHomeScreen> {
  void _handleGoOnline() async {
    LocationPermission permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
      if (permission == LocationPermission.denied ||
          permission == LocationPermission.deniedForever) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text('Location permissions are required to go online.'),
              backgroundColor: AppColors.error,
            ),
          );
        }
        return;
      }
    }

    if (permission == LocationPermission.deniedForever) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
                'Location permissions are permanently denied. Please enable them in settings.'),
            backgroundColor: AppColors.error,
          ),
        );
      }
      return;
    }

    bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
    if (!serviceEnabled) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Location services are disabled. Please turn on GPS.'),
            backgroundColor: AppColors.error,
          ),
        );
      }
      return;
    }

    ref.read(driverControllerProvider.notifier).toggleOnline();
    if (Platform.isAndroid) _checkBatteryOptimization();
  }

  Future<void> _checkBatteryOptimization() async {
    final active = await BatteryOptimizationService.isOptimizationActive();
    if (!active || !mounted) return;

    final shown = await BatteryOptimizationService.wasPromptShown();
    await BatteryOptimizationService.markPromptShown();

    if (!mounted) return;

    if (!shown) {
      showModalBottomSheet(
        context: context,
        isScrollControlled: true,
        backgroundColor: Colors.transparent,
        builder: (_) => const BatteryOptimizationSheet(),
      );
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: const Row(
            children: [
              Icon(Icons.battery_alert_rounded,
                  color: AppColors.primary, size: 18),
              SizedBox(width: 10),
              Expanded(
                child: Text(
                  'Battery optimization is active — you may miss trips.',
                  style: TextStyle(color: AppColors.white, fontSize: 13),
                ),
              ),
            ],
          ),
          backgroundColor: AppColors.charcoal,
          action: SnackBarAction(
            label: 'Fix',
            textColor: AppColors.primary,
            onPressed: BatteryOptimizationService.openSettings,
          ),
          duration: const Duration(seconds: 6),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final driverState = ref.watch(driverControllerProvider);
    final hideHeader = driverState.tripStep != TripStep.none;

    return Scaffold(
      backgroundColor: AppColors.charcoal,
      body: Stack(
        children: [
          GoogleMap(
            initialCameraPosition: const CameraPosition(
              target: LatLng(6.1264, 6.7876),
              zoom: 15,
            ),
            myLocationEnabled: true,
            myLocationButtonEnabled: false,
            zoomControlsEnabled: false,
            compassEnabled: false,
            onMapCreated: (_) {},
            mapType: MapType.normal,
          ),

          if (!hideHeader) _buildStatusHeader(driverState),

          if (!hideHeader && driverState.profile.debtAmount >= 1000)
            _buildDebtBanner(driverState.profile.debtAmount),

          if (driverState.errorMessage != null)
            Positioned(
              bottom: 100,
              left: 20,
              right: 20,
              child: _ErrorToast(
                message: driverState.errorMessage!,
                onDismiss: () =>
                    ref.read(driverControllerProvider.notifier).clearError(),
              ),
            ),

          if (driverState.activeRequest != null &&
              driverState.tripStep == TripStep.none)
            IncomingRequestCard(
              request: driverState.activeRequest!,
              countdown: driverState.countdown ?? 30,
            ),

          if (driverState.tripStep != TripStep.none)
            TripOperationHUD(state: driverState),
        ],
      ),
    );
  }

  Widget _buildStatusHeader(DriverState state) {
    final isOnline = state.operationStatus != OperationStatus.offline;
    final topPad = MediaQuery.of(context).padding.top + 12;

    return Positioned(
      top: topPad,
      left: 16,
      right: 16,
      child: Row(
        children: [
          // Status pill
          Expanded(
            child: Container(
              height: 56,
              decoration: BoxDecoration(
                color: AppColors.charcoal,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(
                  color: isOnline ? AppColors.primary : AppColors.border,
                  width: 1.5,
                ),
                boxShadow: const [
                  BoxShadow(
                      color: Color(0x30000000),
                      blurRadius: 12,
                      offset: Offset(0, 4)),
                ],
              ),
              child: Row(
                children: [
                  const SizedBox(width: 16),
                  // Online indicator dot with pulse when online
                  if (isOnline)
                    _PulseDot()
                  else
                    Container(
                      width: 10,
                      height: 10,
                      decoration: const BoxDecoration(
                        color: AppColors.lightGray,
                        shape: BoxShape.circle,
                      ),
                    ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          isOnline ? 'Online' : 'Offline',
                          style: AppTextStyles.body(
                            color: AppColors.white,
                            weight: FontWeight.w700,
                          ),
                        ),
                        if (isOnline)
                          Builder(builder: (context) {
                            final socketService =
                                ref.watch(socketServiceProvider);
                            final connected =
                                socketService?.isConnected ?? false;
                            return Text(
                              connected
                                  ? 'Looking for rides...'
                                  : 'Connecting...',
                              style: AppTextStyles.caption(
                                color: connected
                                    ? AppColors.lightGray
                                    : AppColors.warning,
                              ),
                            );
                          }),
                        if (!isOnline)
                          Text(
                            'Tap to go online',
                            style:
                                AppTextStyles.caption(color: AppColors.midGray),
                          ),
                      ],
                    ),
                  ),
                  Transform.scale(
                    scale: 0.85,
                    child: Switch(
                      value: isOnline,
                      onChanged: (goingOnline) {
                        if (goingOnline) {
                          _handleGoOnline();
                        } else {
                          ref
                              .read(driverControllerProvider.notifier)
                              .toggleOnline();
                        }
                      },
                      activeThumbColor: AppColors.charcoal,
                      activeTrackColor: AppColors.primary,
                      inactiveThumbColor: AppColors.lightGray,
                      inactiveTrackColor: AppColors.darkGray,
                    ),
                  ),
                  const SizedBox(width: 4),
                ],
              ),
            ),
          ),
          const SizedBox(width: 10),

          // Wallet / earnings button
          _HeaderIconButton(
            icon: Icons.account_balance_wallet_outlined,
            onTap: () => Navigator.push(context,
                MaterialPageRoute(builder: (_) => const EarningsScreen())),
          ),
          const SizedBox(width: 8),
          // Profile button
          _HeaderIconButton(
            icon: Icons.person_outline,
            onTap: () => Navigator.push(
                context,
                MaterialPageRoute(
                    builder: (_) => const DriverProfileScreen())),
          ),
          const SizedBox(width: 8),
          // Logout button
          _HeaderIconButton(
            icon: Icons.logout_rounded,
            onTap: () =>
                ref.read(authControllerProvider.notifier).logout(),
            isDestructive: true,
          ),
        ],
      ),
    );
  }

  Widget _buildDebtBanner(double amount) {
    final topPad = MediaQuery.of(context).padding.top + 80;

    Color borderColor;
    Color bgColor;
    Color fgColor;
    String message;
    IconData icon;

    if (amount >= 5000) {
      borderColor = AppColors.error;
      bgColor = const Color(0xFFFFEBEB);
      fgColor = const Color(0xFF991B1B);
      message = 'Account blocked — pay ₦${amount.toStringAsFixed(0)} to go online';
      icon = Icons.block_rounded;
    } else if (amount >= 2000) {
      borderColor = const Color(0xFFEA580C);
      bgColor = const Color(0xFFFFF7ED);
      fgColor = const Color(0xFF9A3412);
      message =
          'Cash rides blocked — ₦${amount.toStringAsFixed(0)} debt outstanding';
      icon = Icons.warning_amber_rounded;
    } else {
      borderColor = AppColors.primary;
      bgColor = AppColors.primaryLight;
      fgColor = AppColors.primaryDark;
      message = 'Debt warning: ₦${amount.toStringAsFixed(0)} owed';
      icon = Icons.info_outline_rounded;
    }

    return Positioned(
      top: topPad,
      left: 16,
      right: 16,
      child: GestureDetector(
        onTap: () => Navigator.push(context,
            MaterialPageRoute(builder: (_) => const EarningsScreen())),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: BoxDecoration(
            color: bgColor,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: borderColor),
            boxShadow: const [
              BoxShadow(
                  color: Color(0x20000000), blurRadius: 8, offset: Offset(0, 2)),
            ],
          ),
          child: Row(
            children: [
              Icon(icon, color: fgColor, size: 18),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  message,
                  style: AppTextStyles.bodySmall(
                      color: fgColor, weight: FontWeight.w600),
                ),
              ),
              Icon(Icons.chevron_right, color: fgColor, size: 18),
            ],
          ),
        ),
      ),
    );
  }
}

// ─── Widgets ─────────────────────────────────────────────────────────────────

class _PulseDot extends StatefulWidget {
  @override
  State<_PulseDot> createState() => _PulseDotState();
}

class _PulseDotState extends State<_PulseDot>
    with SingleTickerProviderStateMixin {
  late final AnimationController _pulse;
  late final Animation<double> _scale;

  @override
  void initState() {
    super.initState();
    _pulse = AnimationController(
        vsync: this, duration: const Duration(milliseconds: 900))
      ..repeat(reverse: true);
    _scale = Tween<double>(begin: 0.85, end: 1.15)
        .animate(CurvedAnimation(parent: _pulse, curve: Curves.easeInOut));
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ScaleTransition(
      scale: _scale,
      child: Container(
        width: 10,
        height: 10,
        decoration: BoxDecoration(
          color: AppColors.success,
          shape: BoxShape.circle,
          boxShadow: [
            BoxShadow(
              color: AppColors.success.withOpacity(0.5),
              blurRadius: 6,
              spreadRadius: 1,
            ),
          ],
        ),
      ),
    );
  }
}

class _HeaderIconButton extends StatelessWidget {
  final IconData icon;
  final VoidCallback onTap;
  final bool isDestructive;

  const _HeaderIconButton({
    required this.icon,
    required this.onTap,
    this.isDestructive = false,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 48,
        height: 56,
        decoration: BoxDecoration(
          color: AppColors.charcoal,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
            color: isDestructive
                ? AppColors.error.withOpacity(0.3)
                : AppColors.border.withOpacity(0.3),
          ),
          boxShadow: const [
            BoxShadow(
                color: Color(0x28000000),
                blurRadius: 12,
                offset: Offset(0, 4)),
          ],
        ),
        child: Icon(
          icon,
          color: isDestructive ? AppColors.error : AppColors.white,
          size: 20,
        ),
      ),
    );
  }
}

class _ErrorToast extends StatefulWidget {
  final String message;
  final VoidCallback onDismiss;

  const _ErrorToast({required this.message, required this.onDismiss});

  @override
  State<_ErrorToast> createState() => _ErrorToastState();
}

class _ErrorToastState extends State<_ErrorToast> {
  late final Timer _timer;

  @override
  void initState() {
    super.initState();
    _timer = Timer(const Duration(seconds: 5), widget.onDismiss);
  }

  @override
  void dispose() {
    _timer.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: AppColors.charcoal,
        borderRadius: BorderRadius.circular(12),
        boxShadow: const [
          BoxShadow(color: Color(0x33000000), blurRadius: 16)
        ],
      ),
      child: Row(
        children: [
          const Icon(Icons.info_outline, color: AppColors.primary, size: 18),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              widget.message,
              style: AppTextStyles.bodySmall(color: AppColors.white),
            ),
          ),
          const SizedBox(width: 8),
          GestureDetector(
            onTap: widget.onDismiss,
            child: const Icon(Icons.close, color: AppColors.lightGray, size: 16),
          ),
        ],
      ),
    );
  }
}
