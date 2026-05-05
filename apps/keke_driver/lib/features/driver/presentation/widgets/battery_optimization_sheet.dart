import 'package:flutter/material.dart';
import '../../../../core/theme/app_theme.dart';
import '../../../../core/services/battery_optimization_service.dart';

/// Full-page bottom sheet shown the first time a driver goes online
/// while battery optimization is still active.
class BatteryOptimizationSheet extends StatelessWidget {
  const BatteryOptimizationSheet({super.key});

  @override
  Widget build(BuildContext context) {
    final bottomPad = MediaQuery.of(context).padding.bottom;

    return Container(
      decoration: const BoxDecoration(
        color: AppColors.charcoal,
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      padding: EdgeInsets.fromLTRB(24, 12, 24, bottomPad + 24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // drag handle
          Center(
            child: Container(
              width: 40,
              height: 4,
              decoration: BoxDecoration(
                color: AppColors.darkGray,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ),
          const SizedBox(height: 20),

          // icon badge
          Container(
            width: 52,
            height: 52,
            decoration: BoxDecoration(
              color: AppColors.primaryLight,
              borderRadius: BorderRadius.circular(16),
            ),
            child: const Icon(
              Icons.battery_charging_full_rounded,
              color: AppColors.primary,
              size: 28,
            ),
          ),
          const SizedBox(height: 16),

          Text(
            'Allow Background Access',
            style: AppTextStyles.title(
                color: AppColors.white, weight: FontWeight.w700),
          ),
          const SizedBox(height: 10),

          Text(
            'To receive ride requests and share your live location, '
            'Keke Driver must be allowed to run in the background.',
            style: AppTextStyles.body(color: AppColors.lightGray),
          ),
          const SizedBox(height: 6),
          Text(
            'Without this, Android may stop the app while you\'re online '
            'and you\'ll miss trips.',
            style: AppTextStyles.body(color: AppColors.lightGray),
          ),
          const SizedBox(height: 20),

          // OEM tip box
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: AppColors.darkGray,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.info_outline_rounded,
                    color: AppColors.primary, size: 18),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    'Samsung / Xiaomi / Oppo: after tapping "Allow", also go to '
                    'Settings → Battery → App Battery Usage and set Keke Driver '
                    'to "Unrestricted".',
                    style: AppTextStyles.bodySmall(color: AppColors.lightGray),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),

          // Primary CTA — triggers the standard Android exemption dialog
          SizedBox(
            width: double.infinity,
            height: 52,
            child: ElevatedButton.icon(
              onPressed: () async {
                await BatteryOptimizationService.requestExemption();
                if (context.mounted) Navigator.pop(context);
              },
              icon: const Icon(Icons.shield_outlined, size: 20),
              label: Text('Allow Background Access',
                  style: AppTextStyles.button()),
              style: ElevatedButton.styleFrom(
                backgroundColor: AppColors.primary,
                foregroundColor: AppColors.charcoal,
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(14)),
              ),
            ),
          ),
          const SizedBox(height: 10),

          // Secondary — opens battery optimization settings list (OEM fallback)
          SizedBox(
            width: double.infinity,
            height: 48,
            child: OutlinedButton.icon(
              onPressed: () async {
                await BatteryOptimizationService.openSettings();
                if (context.mounted) Navigator.pop(context);
              },
              icon: const Icon(Icons.settings_outlined,
                  size: 18, color: AppColors.primary),
              label: Text(
                'Open Battery Settings Manually',
                style: AppTextStyles.body(
                    color: AppColors.primary, weight: FontWeight.w600),
              ),
              style: OutlinedButton.styleFrom(
                side: const BorderSide(color: AppColors.darkGray),
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(14)),
              ),
            ),
          ),
          const SizedBox(height: 6),

          // Dismiss — non-blocking, driver is already online
          SizedBox(
            width: double.infinity,
            height: 44,
            child: TextButton(
              onPressed: () => Navigator.pop(context),
              child: Text(
                'Skip for Now',
                style: AppTextStyles.body(color: AppColors.midGray),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
