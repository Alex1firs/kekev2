import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import '../../../../core/theme/app_theme.dart';
import '../../auth/application/auth_controller.dart';
import '../application/driver_controller.dart';
import '../domain/driver_profile.dart';
import '../domain/driver_state.dart';
import 'driver_profile_screen.dart';
import 'earnings_screen.dart';
import 'widgets/incoming_request_card.dart';
import 'widgets/trip_operation_hud.dart';

class DriverHomeScreen extends ConsumerStatefulWidget {
  const DriverHomeScreen({super.key});

  @override
  ConsumerState<DriverHomeScreen> createState() => _DriverHomeScreenState();
}

class _DriverHomeScreenState extends ConsumerState<DriverHomeScreen> {
  @override
  Widget build(BuildContext context) {
    final driverState = ref.watch(driverControllerProvider);
    final profile = driverState.profile;

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

          if (!hideHeader && profile.debtAmount >= 1000)
            _buildDebtBanner(profile.debtAmount),

          if (driverState.errorMessage != null)
            Positioned(
              bottom: 100,
              left: 20,
              right: 20,
              child: _ErrorToast(message: driverState.errorMessage!),
            ),

          if (driverState.activeRequest != null && driverState.tripStep == TripStep.none)
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
                color: isOnline ? AppColors.charcoal : AppColors.charcoal,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(
                  color: isOnline ? AppColors.primary : AppColors.border,
                  width: 1.5,
                ),
                boxShadow: const [
                  BoxShadow(color: Color(0x28000000), blurRadius: 12, offset: Offset(0, 4)),
                ],
              ),
              child: Row(
                children: [
                  const SizedBox(width: 16),
                  Container(
                    width: 10,
                    height: 10,
                    decoration: BoxDecoration(
                      color: isOnline ? AppColors.success : AppColors.lightGray,
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
                          Text(
                            'Looking for rides...',
                            style: AppTextStyles.caption(color: AppColors.lightGray),
                          ),
                      ],
                    ),
                  ),
                  Transform.scale(
                    scale: 0.85,
                    child: Switch(
                      value: isOnline,
                      onChanged: (_) =>
                          ref.read(driverControllerProvider.notifier).toggleOnline(),
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

          // Action icons
          _HeaderIconButton(
            icon: Icons.account_balance_wallet_outlined,
            onTap: () => Navigator.push(
              context, MaterialPageRoute(builder: (_) => const EarningsScreen())),
          ),
          const SizedBox(width: 8),
          _HeaderIconButton(
            icon: Icons.person_outline,
            onTap: () => Navigator.push(
              context, MaterialPageRoute(builder: (_) => const DriverProfileScreen())),
          ),
          const SizedBox(width: 8),
          _HeaderIconButton(
            icon: Icons.logout_rounded,
            onTap: () => ref.read(authControllerProvider.notifier).logout(),
          ),
        ],
      ),
    );
  }

  Widget _buildDebtBanner(double amount) {
    final topPad = MediaQuery.of(context).padding.top + 80;

    Color borderColor;
    Color bgColor;
    String message;
    IconData icon;

    if (amount >= 5000) {
      borderColor = AppColors.error;
      bgColor = const Color(0xFFFFEBEB);
      message = 'Account blocked — pay ₦${amount.toStringAsFixed(0)} to go online';
      icon = Icons.block_rounded;
    } else if (amount >= 2000) {
      borderColor = const Color(0xFFEA580C);
      bgColor = const Color(0xFFFFF7ED);
      message = 'Cash rides blocked — ₦${amount.toStringAsFixed(0)} debt outstanding';
      icon = Icons.warning_amber_rounded;
    } else {
      borderColor = AppColors.primary;
      bgColor = AppColors.primaryLight;
      message = 'Debt warning: ₦${amount.toStringAsFixed(0)} owed to platform';
      icon = Icons.info_outline_rounded;
    }

    return Positioned(
      top: topPad,
      left: 16,
      right: 16,
      child: GestureDetector(
        onTap: () => Navigator.push(
          context, MaterialPageRoute(builder: (_) => const EarningsScreen())),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: BoxDecoration(
            color: bgColor,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: borderColor),
            boxShadow: const [
              BoxShadow(color: Color(0x18000000), blurRadius: 8, offset: Offset(0, 2)),
            ],
          ),
          child: Row(
            children: [
              Icon(icon, color: borderColor, size: 18),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  message,
                  style: AppTextStyles.bodySmall(color: borderColor, weight: FontWeight.w600),
                ),
              ),
              Icon(Icons.chevron_right, color: borderColor, size: 18),
            ],
          ),
        ),
      ),
    );
  }
}

class _HeaderIconButton extends StatelessWidget {
  final IconData icon;
  final VoidCallback onTap;

  const _HeaderIconButton({required this.icon, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 44,
        height: 56,
        decoration: BoxDecoration(
          color: AppColors.charcoal,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: AppColors.border.withOpacity(0.3)),
          boxShadow: const [
            BoxShadow(color: Color(0x28000000), blurRadius: 12, offset: Offset(0, 4)),
          ],
        ),
        child: Icon(icon, color: AppColors.white, size: 20),
      ),
    );
  }
}

class _ErrorToast extends StatelessWidget {
  final String message;
  const _ErrorToast({required this.message});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: AppColors.charcoal,
        borderRadius: BorderRadius.circular(12),
        boxShadow: const [BoxShadow(color: Color(0x33000000), blurRadius: 16)],
      ),
      child: Row(
        children: [
          const Icon(Icons.info_outline, color: AppColors.primary, size: 18),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              message,
              style: AppTextStyles.bodySmall(color: AppColors.white),
              textAlign: TextAlign.center,
            ),
          ),
        ],
      ),
    );
  }
}
