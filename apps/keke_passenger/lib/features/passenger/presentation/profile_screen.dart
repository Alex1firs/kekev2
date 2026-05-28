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

  Future<void> _confirmDeleteAccount(BuildContext context) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: Text('Delete Account',
            style: AppTextStyles.title(color: AppColors.charcoal)),
        content: Text(
          'This will permanently delete your account and all associated data. This action cannot be undone.',
          style: AppTextStyles.body(color: AppColors.darkGray),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: Text('Cancel',
                style: AppTextStyles.body(color: AppColors.midGray)),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: AppColors.error,
              foregroundColor: AppColors.white,
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12)),
            ),
            onPressed: () => Navigator.pop(ctx, true),
            child: Text('Delete',
                style: AppTextStyles.body(
                    color: AppColors.white, weight: FontWeight.w700)),
          ),
        ],
      ),
    );

    if (confirmed != true || !mounted) return;

    try {
      await ref.read(authControllerProvider.notifier).deleteAccount();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            e.toString().replaceFirst('Exception: ', ''),
            style: const TextStyle(color: Colors.white),
          ),
          backgroundColor: AppColors.error,
          behavior: SnackBarBehavior.floating,
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        ),
      );
    }
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
      backgroundColor: AppColors.snow,
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

        const SizedBox(height: 40),
        OutlinedButton.icon(
          style: OutlinedButton.styleFrom(
            foregroundColor: AppColors.error,
            side: const BorderSide(color: AppColors.error),
            padding: const EdgeInsets.symmetric(vertical: 16),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(14),
            ),
          ),
          icon: const Icon(Icons.logout_rounded),
          label: Text(
            'Logout',
            style: AppTextStyles.body(color: AppColors.error, weight: FontWeight.w700),
          ),
          onPressed: () => ref.read(authControllerProvider.notifier).logout(),
        ),
        const SizedBox(height: 12),
        TextButton(
          onPressed: () => _confirmDeleteAccount(context),
          child: Text(
            'Delete Account',
            style: AppTextStyles.bodySmall(color: AppColors.midGray),
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
        color: AppColors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        children: [
          Container(
            width: 38,
            height: 38,
            decoration: BoxDecoration(
              color: AppColors.primary.withOpacity(0.1),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(icon, color: AppColors.primaryDark, size: 18),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: AppTextStyles.caption(color: AppColors.midGray)),
                const SizedBox(height: 2),
                Text(value,
                    style: AppTextStyles.body(
                        color: AppColors.charcoal, weight: FontWeight.w600)),
              ],
            ),
          ),
          const Icon(Icons.chevron_right_rounded,
              size: 18, color: AppColors.lightGray),
        ],
      ),
    );
  }
}
