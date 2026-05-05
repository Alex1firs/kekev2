import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../../core/theme/app_theme.dart';
import '../../auth/application/auth_controller.dart';
import '../application/driver_controller.dart';
import '../domain/driver_profile.dart';

class StatusInfoScreen extends ConsumerWidget {
  const StatusInfoScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final driverState = ref.watch(driverControllerProvider);
    final status = driverState.profile.status;

    final _StatusConfig config = _StatusConfig.from(status);

    return Scaffold(
      backgroundColor: AppColors.charcoal,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 32),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              const Spacer(),

              // Icon
              Container(
                width: 96,
                height: 96,
                decoration: BoxDecoration(
                  color: config.color.withOpacity(0.15),
                  shape: BoxShape.circle,
                ),
                child: Icon(config.icon, size: 48, color: config.color),
              ),
              const SizedBox(height: 32),

              // Title
              Text(
                config.title,
                style: AppTextStyles.headline(
                    color: AppColors.white, weight: FontWeight.w800),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 16),

              // Body
              Text(
                config.body,
                textAlign: TextAlign.center,
                style: AppTextStyles.body(color: AppColors.midGray),
              ),

              if (status == DriverStatus.rejected) ...[
                const SizedBox(height: 40),
                SizedBox(
                  width: double.infinity,
                  child: ElevatedButton(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppColors.primary,
                      foregroundColor: AppColors.charcoal,
                      padding: const EdgeInsets.symmetric(vertical: 18),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(16),
                      ),
                      elevation: 0,
                    ),
                    onPressed: () => context.push('/onboarding'),
                    child: Text(
                      'Resubmit Documents',
                      style: AppTextStyles.body(
                          color: AppColors.charcoal, weight: FontWeight.w700),
                    ),
                  ),
                ),
              ],

              const Spacer(),

              TextButton(
                onPressed: () =>
                    ref.read(authControllerProvider.notifier).logout(),
                child: Text(
                  'Log Out',
                  style: AppTextStyles.body(color: AppColors.midGray),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _StatusConfig {
  final IconData icon;
  final Color color;
  final String title;
  final String body;

  const _StatusConfig({
    required this.icon,
    required this.color,
    required this.title,
    required this.body,
  });

  factory _StatusConfig.from(DriverStatus status) {
    switch (status) {
      case DriverStatus.pendingApproval:
        return const _StatusConfig(
          icon: Icons.hourglass_top_rounded,
          color: AppColors.primary,
          title: 'Under Review',
          body:
              'Your documents are being verified by the Keke platform team. This usually takes up to 24 hours. You\'ll be able to start driving once approved.',
        );
      case DriverStatus.suspended:
        return const _StatusConfig(
          icon: Icons.block_rounded,
          color: AppColors.error,
          title: 'Account Suspended',
          body:
              'Your account has been temporarily suspended. Please contact Keke support to resolve this and get back on the road.',
        );
      case DriverStatus.rejected:
        return _StatusConfig(
          icon: Icons.warning_amber_rounded,
          color: const Color(0xFFFBBF24),
          title: 'Verification Failed',
          body:
              'Your documents could not be verified — they may have been unclear or invalid. Please resubmit clear photos of all required documents.',
        );
      default:
        return const _StatusConfig(
          icon: Icons.help_outline_rounded,
          color: AppColors.midGray,
          title: 'Checking Status',
          body: 'We\'re reviewing your account. Please check back shortly.',
        );
    }
  }
}
