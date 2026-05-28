import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../../core/theme/app_theme.dart';
import '../../auth/application/auth_controller.dart';
import '../application/driver_controller.dart';
import '../domain/driver_profile.dart';

class StatusInfoScreen extends ConsumerStatefulWidget {
  const StatusInfoScreen({super.key});

  @override
  ConsumerState<StatusInfoScreen> createState() => _StatusInfoScreenState();
}

class _StatusInfoScreenState extends ConsumerState<StatusInfoScreen> {
  bool _justChecked = false;

  @override
  Widget build(BuildContext context) {
    final driverState = ref.watch(driverControllerProvider);
    final status = driverState.profile.status;
    final config = _StatusConfig.from(status);
    final isChecking = driverState.isLoading;

    ref.listen(driverControllerProvider, (previous, next) {
      if (previous?.isLoading == true && !next.isLoading && _justChecked) {
        _justChecked = false;

        if (next.errorMessage != null) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(next.errorMessage!),
            backgroundColor: AppColors.error,
            behavior: SnackBarBehavior.floating,
          ));
          return;
        }

        if (next.profile.status == DriverStatus.pendingApproval) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: const Text(
              "Still under review — we'll notify you once your account is approved.",
              style: TextStyle(
                color: Colors.white,
                fontSize: 14,
                fontWeight: FontWeight.w500,
              ),
            ),
            backgroundColor: const Color(0xFF334155),
            behavior: SnackBarBehavior.floating,
            shape:
                RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
          ));
        }
      }
    });

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

              // Icon circle
              Container(
                width: 100,
                height: 100,
                decoration: BoxDecoration(
                  color: config.color.withOpacity(0.12),
                  shape: BoxShape.circle,
                  border:
                      Border.all(color: config.color.withOpacity(0.3), width: 2),
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

              // Body text
              Text(
                config.body,
                textAlign: TextAlign.center,
                style: AppTextStyles.body(color: AppColors.midGray),
              ),

              // Complete onboarding CTA for pending documents
              if (status == DriverStatus.pendingDocuments) ...[
                const SizedBox(height: 40),
                SizedBox(
                  width: double.infinity,
                  child: ElevatedButton(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppColors.primary,
                      foregroundColor: AppColors.charcoal,
                      padding: const EdgeInsets.symmetric(vertical: 18),
                      shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(16)),
                      elevation: 0,
                    ),
                    onPressed: () => context.push('/onboarding'),
                    child: Text(
                      'Complete Onboarding',
                      style: AppTextStyles.body(
                          color: AppColors.charcoal, weight: FontWeight.w700),
                    ),
                  ),
                ),
              ],

              // Resubmit button for rejected status
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
                          borderRadius: BorderRadius.circular(16)),
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

              // Check Status button for pending approval
              if (status == DriverStatus.pendingApproval) ...[
                const SizedBox(height: 32),
                SizedBox(
                  width: double.infinity,
                  child: OutlinedButton(
                    style: OutlinedButton.styleFrom(
                      foregroundColor: config.color,
                      side: BorderSide(color: config.color.withOpacity(0.5)),
                      padding: const EdgeInsets.symmetric(vertical: 16),
                      shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(14)),
                    ),
                    onPressed: isChecking
                        ? null
                        : () {
                            setState(() => _justChecked = true);
                            ref
                                .read(driverControllerProvider.notifier)
                                .refreshDriverStatus();
                          },
                    child: isChecking
                        ? SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(
                              strokeWidth: 2.5,
                              valueColor:
                                  AlwaysStoppedAnimation<Color>(config.color),
                            ),
                          )
                        : Row(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Icon(Icons.refresh_rounded,
                                  size: 18, color: config.color),
                              const SizedBox(width: 8),
                              Text(
                                'Check Status',
                                style: AppTextStyles.body(
                                    color: config.color,
                                    weight: FontWeight.w600),
                              ),
                            ],
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
              'Your documents are being verified by the Keke team. This usually takes up to 24 hours. You\'ll be notified once approved.',
        );
      case DriverStatus.pendingDocuments:
        return const _StatusConfig(
          icon: Icons.upload_file_rounded,
          color: Color(0xFFFBBF24),
          title: 'Documents Required',
          body:
              'You need to upload your vehicle documents before we can review your account. Tap below to complete onboarding.',
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
        return const _StatusConfig(
          icon: Icons.warning_amber_rounded,
          color: Color(0xFFFBBF24),
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
