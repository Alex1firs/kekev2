import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';
import '../../../core/theme/app_theme.dart';
import '../../driver/application/driver_controller.dart';

class SplashScreen extends ConsumerWidget {
  const SplashScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Surface a retry affordance if the driver profile failed to load, so a
    // persistent network failure doesn't strand the driver on an endless
    // spinner (the auth guard holds here until the status is confirmed).
    final driverState = ref.watch(driverControllerProvider);
    final hasError = !driverState.isLoading &&
        !driverState.profileLoaded &&
        driverState.errorMessage != null;

    return Scaffold(
      backgroundColor: AppColors.charcoal,
      body: SafeArea(
        child: Column(
          children: [
            const Spacer(flex: 2),
            Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  ClipRRect(
                    borderRadius: BorderRadius.circular(24),
                    child: Image.asset(
                      'assets/images/app_logo.png',
                      width: 110,
                      height: 110,
                      fit: BoxFit.cover,
                    ),
                  ),
                  const SizedBox(height: 24),
                  Text(
                    'Keke Driver',
                    style: GoogleFonts.plusJakartaSans(
                      fontSize: 36,
                      fontWeight: FontWeight.w800,
                      color: AppColors.white,
                      letterSpacing: -1.0,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    'Earn More, Drive Smart',
                    style: GoogleFonts.plusJakartaSans(
                      fontSize: 15,
                      fontWeight: FontWeight.w400,
                      color: AppColors.midGray,
                      letterSpacing: 0.2,
                    ),
                  ),
                ],
              ),
            ),
            const Spacer(flex: 2),
            Padding(
              padding: const EdgeInsets.only(bottom: 48, left: 32, right: 32),
              child: hasError
                  ? _RetrySection(
                      message: driverState.errorMessage!,
                      onRetry: () => ref
                          .read(driverControllerProvider.notifier)
                          .retryProfileLoad(),
                    )
                  : Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        SizedBox(
                          width: 28,
                          height: 28,
                          child: CircularProgressIndicator(
                            strokeWidth: 2.5,
                            valueColor:
                                AlwaysStoppedAnimation<Color>(AppColors.primary),
                          ),
                        ),
                        const SizedBox(height: 16),
                        Text(
                          'Getting things ready...',
                          style: GoogleFonts.plusJakartaSans(
                            fontSize: 13,
                            color: AppColors.midGray,
                          ),
                        ),
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

class _RetrySection extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;

  const _RetrySection({required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          message,
          textAlign: TextAlign.center,
          style: GoogleFonts.plusJakartaSans(
            fontSize: 13,
            color: AppColors.midGray,
          ),
        ),
        const SizedBox(height: 16),
        SizedBox(
          width: double.infinity,
          child: ElevatedButton(
            onPressed: onRetry,
            style: ElevatedButton.styleFrom(
              backgroundColor: AppColors.primary,
              foregroundColor: AppColors.charcoal,
              padding: const EdgeInsets.symmetric(vertical: 14),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
              ),
            ),
            child: Text(
              'Try Again',
              style: GoogleFonts.plusJakartaSans(
                fontSize: 15,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ),
      ],
    );
  }
}
