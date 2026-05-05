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
      padding: const EdgeInsets.fromLTRB(20, 24, 20, 32),
      children: [
        // Avatar
        Center(
          child: Column(
            children: [
              Container(
                width: 88,
                height: 88,
                decoration: BoxDecoration(
                  color: AppColors.primaryLight,
                  shape: BoxShape.circle,
                  border: Border.all(
                    color: AppColors.primary.withOpacity(0.3),
                    width: 2,
                  ),
                ),
                child: Center(
                  child: Text(
                    initials.isNotEmpty ? initials : '?',
                    style: AppTextStyles.display(
                      color: AppColors.primaryDark,
                      weight: FontWeight.w700,
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 14),
              Text(
                displayName.isNotEmpty ? displayName : 'Passenger',
                style: AppTextStyles.headline(color: AppColors.charcoal),
              ),
              const SizedBox(height: 6),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
                decoration: BoxDecoration(
                  color: AppColors.primaryLight,
                  borderRadius: BorderRadius.circular(20),
                ),
                child: Text(
                  role[0].toUpperCase() + role.substring(1),
                  style: AppTextStyles.caption(
                    color: AppColors.primaryDark,
                    weight: FontWeight.w700,
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 32),

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
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
      decoration: BoxDecoration(
        color: AppColors.white,
        borderRadius: BorderRadius.circular(14),
        boxShadow: const [
          BoxShadow(color: Color(0x08000000), blurRadius: 6, offset: Offset(0, 2)),
        ],
      ),
      child: Row(
        children: [
          Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              color: AppColors.paleGray,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(icon, color: AppColors.midGray, size: 18),
          ),
          const SizedBox(width: 14),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label, style: AppTextStyles.caption(color: AppColors.midGray)),
              const SizedBox(height: 2),
              Text(
                value,
                style: AppTextStyles.body(
                  color: AppColors.charcoal,
                  weight: FontWeight.w600,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
