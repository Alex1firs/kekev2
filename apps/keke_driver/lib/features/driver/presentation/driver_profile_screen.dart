import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:jwt_decoder/jwt_decoder.dart';
import 'package:url_launcher/url_launcher.dart';
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

                const SizedBox(height: 32),
                Padding(
                  padding: const EdgeInsets.only(left: 4, bottom: 12),
                  child: Text(
                    'ACCOUNT & PRIVACY',
                    style: AppTextStyles.caption(
                      color: AppColors.lightGray,
                      weight: FontWeight.w800,
                    ).copyWith(letterSpacing: 1.5),
                  ),
                ),
                Container(
                  decoration: BoxDecoration(
                    color: AppColors.darkGray,
                    borderRadius: BorderRadius.circular(16),
                  ),
                  child: Column(
                    children: [
                      // Location Details Tile
                      _DashboardTile(
                        icon: Icons.location_on_outlined,
                        iconColor: AppColors.primary,
                        title: 'Location Transparency',
                        subtitle: 'Learn why and when your location is tracked',
                        onTap: () => _showLocationDisclosureSheet(context),
                      ),
                      const Divider(color: AppColors.charcoal, height: 1),
                      // Privacy Policy Tile
                      _DashboardTile(
                        icon: Icons.privacy_tip_outlined,
                        iconColor: AppColors.paleGray,
                        title: 'Privacy Policy',
                        subtitle: 'Read our official data privacy policy',
                        onTap: () => _showPrivacyPolicySheet(context),
                      ),
                      const Divider(color: AppColors.charcoal, height: 1),
                      // Log Out Tile
                      _DashboardTile(
                        icon: Icons.logout_rounded,
                        iconColor: AppColors.paleGray,
                        title: 'Log Out',
                        subtitle: 'Safely sign out from this device',
                        onTap: () => ref.read(authControllerProvider.notifier).logout(),
                      ),
                      const Divider(color: AppColors.charcoal, height: 1),
                      // Delete Account Tile (Destructive)
                      _DashboardTile(
                        icon: Icons.delete_forever_outlined,
                        iconColor: AppColors.error,
                        title: 'Permanently Delete Account',
                        subtitle: 'Erase profile, wallet, and all records instantly',
                        isDestructive: true,
                        onTap: () => _showDeleteAccountSheet(context, ref),
                      ),
                    ],
                  ),
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

// ─── Location Transparency & Disclosure Sheet ────────────────────────────────

void _showLocationDisclosureSheet(BuildContext context) {
  showModalBottomSheet(
    context: context,
    backgroundColor: AppColors.charcoal,
    isScrollControlled: true,
    builder: (context) {
      return Container(
        padding: const EdgeInsets.fromLTRB(24, 20, 24, 32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Center(
              child: Container(
                width: 48,
                height: 5,
                decoration: BoxDecoration(
                  color: AppColors.darkGray,
                  borderRadius: BorderRadius.circular(2.5),
                ),
              ),
            ),
            const SizedBox(height: 24),
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: AppColors.primary.withOpacity(0.15),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: const Icon(Icons.location_on, color: AppColors.primary, size: 28),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: Text(
                    'Location Consent',
                    style: AppTextStyles.headline(color: AppColors.white),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 20),
            Text(
              'To receive ride requests and earn with KekeRide, the application requires your background location access.',
              style: AppTextStyles.body(color: AppColors.paleGray, weight: FontWeight.w600),
            ),
            const SizedBox(height: 20),
            const _DisclosureBullet(
              icon: Icons.wifi_tethering,
              title: 'Only Active When Online',
              description: 'We ONLY track your background location when your status is set to ONLINE on the Home screen. Tracking stops completely the moment you go offline.',
            ),
            const _DisclosureBullet(
              icon: Icons.electric_rickshaw_rounded,
              title: 'Precise Dispatching',
              description: 'Location data ensures passengers are matched with the nearest available tricycle, drastically reducing your wait time and increasing trip acceptance.',
            ),
            const _DisclosureBullet(
              icon: Icons.route_rounded,
              title: 'Fare & Safety Tracking',
              description: 'Real-time location is required to calculate accurate trip distance, determine exact fares, and ensure passenger and driver safety.',
            ),
            const SizedBox(height: 24),
            ElevatedButton(
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.primary,
                foregroundColor: AppColors.charcoal,
                minimumSize: const Size(double.infinity, 50),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
              ),
              onPressed: () => Navigator.pop(context),
              child: Text(
                'I Understand',
                style: AppTextStyles.button(color: AppColors.charcoal),
              ),
            ),
          ],
        ),
      );
    },
  );
}

// ─── Delete Account Confirmation Bottom Sheet ────────────────────────────────

void _showDeleteAccountSheet(BuildContext context, WidgetRef ref) {
  bool isLoading = false;
  showModalBottomSheet(
    context: context,
    backgroundColor: AppColors.charcoal,
    isScrollControlled: true,
    builder: (context) {
      return StatefulBuilder(
        builder: (context, setState) {
          return Container(
            padding: EdgeInsets.fromLTRB(24, 20, 24, MediaQuery.of(context).viewInsets.bottom + 32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Center(
                  child: Container(
                    width: 48,
                    height: 5,
                    decoration: BoxDecoration(
                      color: AppColors.darkGray,
                      borderRadius: BorderRadius.circular(2.5),
                    ),
                  ),
                ),
                const SizedBox(height: 24),
                Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: AppColors.error.withOpacity(0.15),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: const Icon(Icons.warning_amber_rounded, color: AppColors.error, size: 28),
                    ),
                    const SizedBox(width: 16),
                    Expanded(
                      child: Text(
                        'Delete Your Account?',
                        style: AppTextStyles.headline(color: AppColors.white),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 20),
                Text(
                  'Warning: This action is permanent and completely irreversible. All your profiles, wallet balances, trip history, and documents will be permanently erased.',
                  style: AppTextStyles.body(color: AppColors.paleGray),
                ),
                const SizedBox(height: 20),
                Container(
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    color: AppColors.darkGray,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: AppColors.error.withOpacity(0.4)),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'What you will lose:',
                        style: AppTextStyles.body(color: AppColors.white, weight: FontWeight.bold),
                      ),
                      const SizedBox(height: 10),
                      Row(
                        children: [
                          const Icon(Icons.circle, color: AppColors.error, size: 8),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              'All active wallet balances and earnings',
                              style: AppTextStyles.bodySmall(color: AppColors.lightGray),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 6),
                      Row(
                        children: [
                          const Icon(Icons.circle, color: AppColors.error, size: 8),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              'Verified status and vehicle approval',
                              style: AppTextStyles.bodySmall(color: AppColors.lightGray),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 6),
                      Row(
                        children: [
                          const Icon(Icons.circle, color: AppColors.error, size: 8),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              'Access to KekeRide Driver services',
                              style: AppTextStyles.bodySmall(color: AppColors.lightGray),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 28),
                if (isLoading)
                  const Center(
                    child: Padding(
                      padding: EdgeInsets.symmetric(vertical: 8),
                      child: CircularProgressIndicator(color: AppColors.error),
                    ),
                  )
                else
                  Row(
                    children: [
                      Expanded(
                        child: OutlinedButton(
                          style: OutlinedButton.styleFrom(
                            foregroundColor: AppColors.white,
                            side: const BorderSide(color: AppColors.midGray),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                            padding: const EdgeInsets.symmetric(vertical: 14),
                          ),
                          onPressed: () => Navigator.pop(context),
                          child: const Text('Cancel'),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: ElevatedButton(
                          style: ElevatedButton.styleFrom(
                            backgroundColor: AppColors.error,
                            foregroundColor: AppColors.white,
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                            padding: const EdgeInsets.symmetric(vertical: 14),
                          ),
                          onPressed: () async {
                            setState(() {
                              isLoading = true;
                            });
                            try {
                              await ref.read(authControllerProvider.notifier).deleteAccount();
                              if (context.mounted) {
                                Navigator.pop(context);
                                ScaffoldMessenger.of(context).showSnackBar(
                                  const SnackBar(
                                    content: Text('Your account has been deleted successfully.'),
                                    backgroundColor: AppColors.success,
                                  ),
                                );
                              }
                            } catch (err) {
                              setState(() {
                                isLoading = false;
                              });
                              if (context.mounted) {
                                ScaffoldMessenger.of(context).showSnackBar(
                                  SnackBar(
                                    content: Text('Failed to delete account: $err'),
                                    backgroundColor: AppColors.error,
                                  ),
                                );
                              }
                            }
                          },
                          child: const Text('Delete'),
                        ),
                      ),
                    ],
                  ),
              ],
            ),
          );
        },
      );
    },
  );
}

// ─── Dashboard Tile Widget ───────────────────────────────────────────────────

class _DashboardTile extends StatelessWidget {
  final IconData icon;
  final Color iconColor;
  final String title;
  final String subtitle;
  final VoidCallback onTap;
  final bool isDestructive;

  const _DashboardTile({
    required this.icon,
    required this.iconColor,
    required this.title,
    required this.subtitle,
    required this.onTap,
    this.isDestructive = false,
  });

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(16),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        child: Row(
          children: [
            Container(
              width: 38,
              height: 38,
              decoration: BoxDecoration(
                color: isDestructive ? AppColors.error.withOpacity(0.12) : AppColors.charcoal,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Icon(icon, color: iconColor, size: 20),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: AppTextStyles.body(
                      color: isDestructive ? AppColors.error : AppColors.white,
                      weight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    subtitle,
                    style: AppTextStyles.caption(
                      color: isDestructive ? AppColors.error.withOpacity(0.7) : AppColors.lightGray,
                    ),
                  ),
                ],
              ),
            ),
            Icon(
              Icons.chevron_right_rounded,
              color: isDestructive ? AppColors.error.withOpacity(0.5) : AppColors.midGray,
              size: 20,
            ),
          ],
        ),
      ),
    );
  }
}

// ─── Disclosure Bullet Item Widget ───────────────────────────────────────────

class _DisclosureBullet extends StatelessWidget {
  final IconData icon;
  final String title;
  final String description;

  const _DisclosureBullet({
    required this.icon,
    required this.title,
    required this.description,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: AppColors.primary, size: 20),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: AppTextStyles.body(color: AppColors.white, weight: FontWeight.bold),
                ),
                const SizedBox(height: 2),
                Text(
                  description,
                  style: AppTextStyles.bodySmall(color: AppColors.lightGray),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

void _showPrivacyPolicySheet(BuildContext context) {
  showModalBottomSheet(
    context: context,
    backgroundColor: AppColors.charcoal,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
    ),
    builder: (context) {
      return Container(
        height: MediaQuery.of(context).size.height * 0.85,
        padding: const EdgeInsets.fromLTRB(24, 20, 24, 24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Center(
              child: Container(
                width: 48,
                height: 5,
                decoration: BoxDecoration(
                  color: AppColors.darkGray,
                  borderRadius: BorderRadius.circular(2.5),
                ),
              ),
            ),
            const SizedBox(height: 24),
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: AppColors.primary.withOpacity(0.15),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: const Icon(Icons.privacy_tip_outlined, color: AppColors.primary, size: 28),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: Text(
                    'Privacy Policy',
                    style: AppTextStyles.headline(color: AppColors.white),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 20),
            Expanded(
              child: SingleChildScrollView(
                physics: const BouncingScrollPhysics(),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'This policy outlines how KekeRide collects, uses, and protects information across our website and products, including Dispatcher, KekeRide Passenger, and KekeRide Driver Apps.',
                      style: AppTextStyles.body(color: AppColors.paleGray, weight: FontWeight.w600),
                    ),
                    const SizedBox(height: 20),
                    _buildPolicySection(
                      title: '1. Personal Data We Collect',
                      content: 'To ensure a reliable and secure ride experience, we collect:\n'
                          '• Contact Info: Your name, phone number, and email address.\n'
                          '• Profile Details: Profile picture, gender, and date of birth.\n'
                          '• Driver Credentials: Driver\'s license number, license plate, tricycle photo, and vehicle registration documents.\n'
                          '• Transactional History: Ride routes, fare details, and payout logs.',
                    ),
                    _buildPolicySection(
                      title: '2. Location Data Collection & Use',
                      content: 'To enable dispatching, routing, and safety tracking, KekeRide collects location data:\n\n'
                          '• KekeRide Driver App: We collect precise background location data ONLY when your driver status is ONLINE. This is critical for matching you with passengers, calculating distance-based fares, and ensuring safety. Location collection stops completely when you go offline.\n\n'
                          '• KekeRide Passenger App: Foreground location data is collected when passengers request rides or look for nearby tricycles.',
                    ),
                    _buildPolicySection(
                      title: '3. How We Use Information',
                      content: 'We use your information to:\n'
                          '• Match drivers with passengers in real-time.\n'
                          '• Calculate accurate distance-based ride fares.\n'
                          '• Verify driver identity and credentials for safety audits.\n'
                          '• Process payouts and wallet top-ups.\n'
                          '• Send ride alerts, safety notifications, and app updates.',
                    ),
                    _buildPolicySection(
                      title: '4. Information Sharing & Security',
                      content: '• Sharing: Matched passengers will see your name, photo, phone number, current location, and vehicle license plate.\n'
                          '• Protection: Your personal data is stored securely using high-grade encryption to prevent unauthorized access.\n'
                          '• Disclosure: KekeRide does NOT sell or rent your personal data to third parties under any circumstances.',
                    ),
                    _buildPolicySection(
                      title: '5. Data Retention & Deletion',
                      content: '• You have the right to request deletion of your account at any time.\n'
                          '• Tapping "Delete Account" inside this dashboard initiates a secure, cascading deletion pipeline that permanently purges your driver profile, vehicle logs, wallet information, and personal identity records from our database within regulatory audit timeframes.',
                    ),
                    const SizedBox(height: 16),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 20),
            ElevatedButton(
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.primary,
                foregroundColor: AppColors.charcoal,
                minimumSize: const Size(double.infinity, 50),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
              ),
              onPressed: () => Navigator.pop(context),
              child: Text(
                'I Acknowledge & Accept',
                style: AppTextStyles.button(color: AppColors.charcoal),
              ),
            ),
          ],
        ),
      );
    },
  );
}

Widget _buildPolicySection({required String title, required String content}) {
  return Padding(
    padding: const EdgeInsets.only(bottom: 20),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          title,
          style: AppTextStyles.body(color: AppColors.white, weight: FontWeight.bold),
        ),
        const SizedBox(height: 8),
        Text(
          content,
          style: AppTextStyles.bodySmall(color: AppColors.paleGray),
        ),
      ],
    ),
  );
}
