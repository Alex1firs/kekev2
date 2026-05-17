import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:jwt_decoder/jwt_decoder.dart';
import '../../../../core/theme/app_theme.dart';
import '../application/driver_controller.dart';
import '../domain/driver_profile.dart';
import '../../auth/application/auth_controller.dart';
import '../../auth/domain/auth_state.dart';

class DriverProfileScreen extends ConsumerWidget {
  const DriverProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final driverState = ref.watch(driverControllerProvider);
    final authState = ref.watch(authControllerProvider);
    final profile = driverState.profile;

    String phone = '';
    if (authState.status == AuthStatus.authenticated &&
        authState.token != null) {
      try {
        final decoded = JwtDecoder.decode(authState.token!);
        phone = decoded['phone']?.toString() ?? '';
      } catch (_) {}
    }

    final firstName = profile.firstName ?? '';
    final lastName = profile.lastName ?? '';
    final initials = [
      if (firstName.isNotEmpty) firstName[0],
      if (lastName.isNotEmpty) lastName[0],
    ].join().toUpperCase();
    final displayName = '$firstName $lastName'.trim();

    return Scaffold(
      backgroundColor: AppColors.charcoal,
      body: Column(
        children: [
          // Dark header banner
          _ProfileHeader(
            initials: initials,
            displayName: displayName,
            status: profile.status,
          ),
          // Body
          Expanded(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(20, 24, 20, 32),
              children: [
                // Vehicle plate — driver identity, most important tile
                if (profile.vehiclePlate != null &&
                    profile.vehiclePlate != 'PENDING') ...[
                  _VehiclePlate(plate: profile.vehiclePlate!),
                  const SizedBox(height: 12),
                ],

                if (phone.isNotEmpty)
                  _InfoTile(
                    icon: Icons.phone_outlined,
                    label: 'Phone',
                    value: phone,
                  ),
                if (profile.vehicleModel != null &&
                    profile.vehicleModel != 'PENDING')
                  _InfoTile(
                    icon: Icons.electric_rickshaw,
                    label: 'Vehicle Model',
                    value: profile.vehicleModel!,
                  ),
                _InfoTile(
                  icon: Icons.badge_outlined,
                  label: 'Account Type',
                  value: 'Driver',
                ),

                if (profile.debtAmount > 0) ...[
                  const SizedBox(height: 4),
                  _DebtWarning(amount: profile.debtAmount),
                ],

                const SizedBox(height: 40),
                OutlinedButton.icon(
                  style: OutlinedButton.styleFrom(
                    foregroundColor: AppColors.error,
                    side: const BorderSide(color: AppColors.error),
                    padding: const EdgeInsets.symmetric(vertical: 16),
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(14)),
                  ),
                  icon: const Icon(Icons.logout_rounded),
                  label: Text('Logout',
                      style: AppTextStyles.body(
                          color: AppColors.error, weight: FontWeight.w700)),
                  onPressed: () =>
                      ref.read(authControllerProvider.notifier).logout(),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ─── Header banner ────────────────────────────────────────────────────────────

class _ProfileHeader extends StatelessWidget {
  final String initials;
  final String displayName;
  final DriverStatus status;

  const _ProfileHeader({
    required this.initials,
    required this.displayName,
    required this.status,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: EdgeInsets.fromLTRB(
          20, MediaQuery.of(context).padding.top + 16, 20, 28),
      decoration: const BoxDecoration(
        color: AppColors.darkGray,
        borderRadius: BorderRadius.only(
          bottomLeft: Radius.circular(28),
          bottomRight: Radius.circular(28),
        ),
      ),
      child: Column(
        children: [
          Row(
            children: [
              IconButton(
                icon: const Icon(Icons.arrow_back, color: AppColors.white),
                onPressed: () => Navigator.pop(context),
              ),
              const Spacer(),
              Text('Profile',
                  style: AppTextStyles.title(color: AppColors.white)),
              const Spacer(),
              const SizedBox(width: 48),
            ],
          ),
          const SizedBox(height: 16),
          Container(
            width: 88,
            height: 88,
            decoration: BoxDecoration(
              color: AppColors.primary,
              shape: BoxShape.circle,
              boxShadow: [
                BoxShadow(
                  color: AppColors.primary.withOpacity(0.4),
                  blurRadius: 16,
                  offset: const Offset(0, 4),
                ),
              ],
            ),
            child: Center(
              child: Text(
                initials.isNotEmpty ? initials : '?',
                style: AppTextStyles.headline(
                    color: AppColors.charcoal, weight: FontWeight.w800),
              ),
            ),
          ),
          const SizedBox(height: 14),
          Text(
            displayName.isNotEmpty ? displayName : 'Driver',
            style: AppTextStyles.headline(color: AppColors.white),
          ),
          const SizedBox(height: 8),
          _StatusBadge(status: status),
        ],
      ),
    );
  }
}

// ─── Vehicle plate (prominent identity tile) ──────────────────────────────────

class _VehiclePlate extends StatelessWidget {
  final String plate;

  const _VehiclePlate({required this.plate});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
      decoration: BoxDecoration(
        color: AppColors.darkGray,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.primary.withOpacity(0.4)),
      ),
      child: Row(
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: AppColors.primary.withOpacity(0.15),
              borderRadius: BorderRadius.circular(12),
            ),
            child: const Icon(Icons.electric_rickshaw,
                color: AppColors.primary, size: 20),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Keke Plate Number',
                    style: AppTextStyles.caption(color: AppColors.midGray)),
                const SizedBox(height: 3),
                Text(
                  plate,
                  style: AppTextStyles.title(
                      color: AppColors.primary, weight: FontWeight.w800),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ─── Info tile ────────────────────────────────────────────────────────────────

class _InfoTile extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;

  const _InfoTile(
      {required this.icon, required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: BoxDecoration(
        color: AppColors.darkGray,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        children: [
          Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              color: AppColors.charcoal,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(icon, color: AppColors.midGray, size: 18),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label,
                    style: AppTextStyles.caption(color: AppColors.midGray)),
                const SizedBox(height: 2),
                Text(value,
                    style: AppTextStyles.body(
                        color: AppColors.white, weight: FontWeight.w600)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ─── Debt warning ─────────────────────────────────────────────────────────────

class _DebtWarning extends StatelessWidget {
  final double amount;

  const _DebtWarning({required this.amount});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: const Color(0xFF3B0A0A),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.error),
      ),
      child: Row(
        children: [
          const Icon(Icons.warning_amber_rounded,
              color: AppColors.error, size: 22),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Commission Debt',
                    style: AppTextStyles.body(
                        color: AppColors.error, weight: FontWeight.w700)),
                Text(
                  '₦${amount.toStringAsFixed(0)} outstanding',
                  style: AppTextStyles.bodySmall(
                      color: const Color(0xFFFCA5A5)),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ─── Status badge ─────────────────────────────────────────────────────────────

class _StatusBadge extends StatelessWidget {
  final DriverStatus status;

  const _StatusBadge({required this.status});

  @override
  Widget build(BuildContext context) {
    Color bg;
    Color fg;
    String label;

    switch (status) {
      case DriverStatus.approved:
        bg = const Color(0xFF064E3B);
        fg = const Color(0xFF6EE7B7);
        label = 'Approved';
        break;
      case DriverStatus.suspended:
        bg = const Color(0xFF3B0A0A);
        fg = const Color(0xFFFCA5A5);
        label = 'Suspended';
        break;
      case DriverStatus.rejected:
        bg = const Color(0xFF3B0A0A);
        fg = AppColors.error;
        label = 'Rejected';
        break;
      case DriverStatus.pendingApproval:
        bg = const Color(0xFF3B2A00);
        fg = AppColors.primary;
        label = 'Pending Review';
        break;
      case DriverStatus.pendingDocuments:
        bg = const Color(0xFF3B1A00);
        fg = const Color(0xFFFBBF24);
        label = 'Documents Needed';
        break;
      default:
        bg = AppColors.darkGray;
        fg = AppColors.midGray;
        label = 'Unregistered';
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(20),
      ),
      child: Text(label,
          style: AppTextStyles.bodySmall(color: fg, weight: FontWeight.w700)),
    );
  }
}
