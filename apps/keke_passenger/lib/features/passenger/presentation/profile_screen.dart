import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:dio/dio.dart' as dio;
import '../../../../core/theme/app_theme.dart';
import '../../../core/network/api_client.dart';
import '../../auth/application/auth_controller.dart';

class PassengerProfileScreen extends ConsumerStatefulWidget {
  const PassengerProfileScreen({super.key});

  @override
  ConsumerState<PassengerProfileScreen> createState() =>
      _PassengerProfileScreenState();
}

class _PassengerProfileScreenState
    extends ConsumerState<PassengerProfileScreen> {
  Map<String, dynamic>? _profile;
  bool _isLoading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadProfile();
  }


  Future<void> _loadProfile() async {
    setState(() {
      _isLoading = true;
      _error = null;
    });
    try {
      final api = ref.read(apiClientProvider);
      final response = await api.dio.get('/auth/me');
      setState(() {
        _profile = response.data as Map<String, dynamic>;
        _isLoading = false;
      });
    } on dio.DioException catch (e) {
      setState(() {
        _error = e.response?.data?['error']?.toString() ?? 'Failed to load profile';
        _isLoading = false;
      });
    } catch (_) {
      setState(() {
        _error = 'Failed to load profile';
        _isLoading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.charcoal,
      appBar: AppBar(
        backgroundColor: AppColors.charcoal,
        foregroundColor: AppColors.white,
        elevation: 0,
        title: Text('My Profile', style: AppTextStyles.title(color: AppColors.white)),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back, color: AppColors.white),
          onPressed: () => Navigator.pop(context),
        ),
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator(color: AppColors.primary))
          : _error != null
              ? _buildError()
              : _buildBody(),
    );
  }

  Widget _buildError() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.error_outline, color: AppColors.error, size: 48),
          const SizedBox(height: 12),
          Text(_error!, style: AppTextStyles.body(color: AppColors.error)),
          const SizedBox(height: 16),
          TextButton(
            onPressed: _loadProfile,
            child: Text('Retry', style: AppTextStyles.body(color: AppColors.primary)),
          ),
        ],
      ),
    );
  }

  Widget _buildBody() {
    final p = _profile!;
    final firstName = p['firstName'] as String? ?? '';
    final lastName = p['lastName'] as String? ?? '';
    final phone = p['phone'] as String? ?? '';
    final role = p['role'] as String? ?? 'passenger';

    final initials = [
      if (firstName.isNotEmpty) firstName[0],
      if (lastName.isNotEmpty) lastName[0],
    ].join().toUpperCase();

    final displayName = '$firstName $lastName'.trim();

    return ListView(
      padding: const EdgeInsets.fromLTRB(20, 0, 20, 32),
      children: [
        // Header banner
        Container(
          margin: const EdgeInsets.fromLTRB(0, 0, 0, 24),
          padding: const EdgeInsets.symmetric(vertical: 32, horizontal: 20),
          decoration: const BoxDecoration(
            color: AppColors.charcoal,
            borderRadius: BorderRadius.only(
              bottomLeft: Radius.circular(28),
              bottomRight: Radius.circular(28),
            ),
          ),
          child: Column(
            children: [
              Container(
                width: 80,
                height: 80,
                decoration: const BoxDecoration(
                  color: AppColors.primary,
                  shape: BoxShape.circle,
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
                displayName.isNotEmpty ? displayName : 'Passenger',
                style: AppTextStyles.headline(color: AppColors.white),
              ),
              const SizedBox(height: 8),
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 14, vertical: 5),
                decoration: BoxDecoration(
                  color: AppColors.primary.withOpacity(0.2),
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(
                      color: AppColors.primary.withOpacity(0.4)),
                ),
                child: Text(
                  role[0].toUpperCase() + role.substring(1),
                  style: AppTextStyles.caption(
                      color: AppColors.primary, weight: FontWeight.w700),
                ),
              ),
            ],
          ),
        ),

        // Info tiles
        if (phone.isNotEmpty)
          _InfoTile(icon: Icons.phone_outlined, label: 'Phone', value: phone),
        _InfoTile(icon: Icons.badge_outlined, label: 'Account Type', value: 'Passenger'),

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
    );
  }
}

class _InfoTile extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;

  const _InfoTile({
    required this.icon,
    required this.label,
    required this.value,
  });

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
                Text(
                  label,
                  style: AppTextStyles.caption(color: AppColors.midGray),
                ),
                const SizedBox(height: 2),
                Text(
                  value,
                  style: AppTextStyles.body(
                    color: AppColors.white,
                    weight: FontWeight.w600,
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

void _showLocationDisclosureSheet(BuildContext context) {
  showModalBottomSheet(
    context: context,
    backgroundColor: AppColors.charcoal,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
    ),
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
              'To find nearest drivers, estimate fares, and request a ride, KekeRide requires access to your location services.',
              style: AppTextStyles.body(color: AppColors.paleGray, weight: FontWeight.w600),
            ),
            const SizedBox(height: 20),
            const _DisclosureBullet(
              icon: Icons.visibility,
              title: 'Only in Foreground',
              description: 'We ONLY access your location when the app is actively open and in use. We DO NOT track your background location under any circumstances.',
            ),
            const _DisclosureBullet(
              icon: Icons.electric_rickshaw_rounded,
              title: 'Accurate Dispatching',
              description: 'Your location is used to pinpoint exact pickup coordinates and show you nearby available tricycles in real-time.',
            ),
            const _DisclosureBullet(
              icon: Icons.security_rounded,
              title: 'Safety & Ride Tracking',
              description: 'Enables safe tracking during your active ride, keeping friends and family updated on your route progress.',
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
                          '• Transactional History: Ride routes, fare details, and payment histories.',
                    ),
                    _buildPolicySection(
                      title: '2. Location Data Collection & Use',
                      content: 'To enable dispatching, routing, and safety tracking, KekeRide collects location data:\n\n'
                          '• KekeRide Passenger App: We collect foreground location data ONLY when the app is actively in use to set pickup coordinates, locate nearby drivers, and trace active ride paths. No background location is collected.\n\n'
                          '• KekeRide Driver App: Precise background location is collected when status is online to dispatch requests.',
                    ),
                    _buildPolicySection(
                      title: '3. How We Use Information',
                      content: 'We use your information to:\n'
                          '• Match passengers with the nearest available drivers.\n'
                          '• Calculate accurate distance-based ride fares.\n'
                          '• Process payments and passenger wallet transactions.\n'
                          '• Send active driver matching alerts and ride updates.',
                    ),
                    _buildPolicySection(
                      title: '4. Information Sharing & Security',
                      content: '• Sharing: Matched drivers will see your name, photo, phone number, and active pickup location.\n'
                          '• Protection: Your personal data is stored securely using high-grade encryption to prevent unauthorized access.\n'
                          '• Disclosure: KekeRide does NOT sell or rent your personal data to third parties under any circumstances.',
                    ),
                    _buildPolicySection(
                      title: '5. Data Retention & Deletion',
                      content: '• You have the right to request deletion of your account at any time.\n'
                          '• Tapping "Delete Account" inside this dashboard initiates a secure, cascading deletion pipeline that permanently purges your passenger profile, saved home/work locations, wallet data, device tokens, and personal identity records from our database within regulatory audit timeframes.',
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

void _showDeleteAccountSheet(BuildContext context, WidgetRef ref) {
  bool isLoading = false;
  showModalBottomSheet(
    context: context,
    backgroundColor: AppColors.charcoal,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
    ),
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
                  'Warning: This action is permanent and completely irreversible. Your profile, active wallet balance, saved locations, and trip history will be permanently erased.',
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
                              'All active wallet balances',
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
                              'Your full passenger trip history',
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
                              'All saved home, work, and favorite locations',
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
