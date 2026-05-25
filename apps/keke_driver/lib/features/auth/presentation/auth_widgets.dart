import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import '../../../core/theme/app_theme.dart';

class AuthTopBar extends StatelessWidget {
  final int step;
  final int totalSteps;
  final VoidCallback onBack;

  const AuthTopBar({
    super.key,
    required this.step,
    required this.totalSteps,
    required this.onBack,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 8, 20, 0),
      child: Row(
        children: [
          IconButton(
            icon: const Icon(Icons.arrow_back, color: AppColors.white),
            onPressed: onBack,
          ),
          const Spacer(),
          Row(
            children: List.generate(totalSteps, (i) => AnimatedContainer(
              duration: const Duration(milliseconds: 300),
              curve: Curves.easeInOut,
              margin: const EdgeInsets.symmetric(horizontal: 3),
              width: step == i ? 22 : 6,
              height: 6,
              decoration: BoxDecoration(
                color: step == i ? AppColors.primary : AppColors.white.withOpacity(0.25),
                borderRadius: BorderRadius.circular(3),
              ),
            )),
          ),
        ],
      ),
    );
  }
}

class AuthStepPage extends StatelessWidget {
  final String question;
  final Widget child;
  final Widget? footer;

  const AuthStepPage({
    super.key,
    required this.question,
    required this.child,
    this.footer,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(28, 40, 28, 20),
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              question,
              style: GoogleFonts.plusJakartaSans(
                fontSize: 34,
                fontWeight: FontWeight.w800,
                color: AppColors.white,
                height: 1.15,
              ),
            ),
            const SizedBox(height: 36),
            child,
            if (footer != null) ...[
              const SizedBox(height: 16),
              footer!,
            ],
          ],
        ),
      ),
    );
  }
}

class AuthBottomBar extends StatelessWidget {
  final String label;
  final bool isBusy;
  final VoidCallback onTap;
  final String footerText;
  final String footerLinkText;
  final VoidCallback onFooterTap;

  const AuthBottomBar({
    super.key,
    required this.label,
    required this.isBusy,
    required this.onTap,
    required this.footerText,
    required this.footerLinkText,
    required this.onFooterTap,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(28, 8, 28, 28),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox(
            width: double.infinity,
            child: ElevatedButton(
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.primary,
                foregroundColor: AppColors.charcoal,
                padding: const EdgeInsets.symmetric(vertical: 16),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                elevation: 0,
              ),
              onPressed: isBusy ? null : onTap,
              child: isBusy
                  ? const SizedBox(
                      height: 20, width: 20,
                      child: CircularProgressIndicator(strokeWidth: 2.5, color: AppColors.charcoal))
                  : Text(label,
                      style: GoogleFonts.plusJakartaSans(
                          fontSize: 15, fontWeight: FontWeight.w700, color: AppColors.charcoal)),
            ),
          ),
          const SizedBox(height: 16),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text('$footerText ', style: AppTextStyles.bodySmall(color: AppColors.midGray)),
              GestureDetector(
                onTap: onFooterTap,
                child: Text(footerLinkText,
                    style: AppTextStyles.bodySmall(color: AppColors.primary, weight: FontWeight.w700)),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
