import 'package:flutter/material.dart';

import '../../../../core/theme/app_theme.dart';
import '../../domain/booking_notice.dart';

/// Renders a [BookingNotice] as a card whose weight matches the outcome:
///
/// * [RideOutcomeTone.info] — soft cream/amber surface. Availability outcomes
///   ("drivers are busy") are normal facts about the world, not app failures.
/// * [RideOutcomeTone.error] — red surface, reserved for things that are
///   genuinely broken (no internet, server error, unusable locations).
class BookingNoticeCard extends StatelessWidget {
  final BookingNotice notice;
  final VoidCallback? onSearchAgain;
  final VoidCallback? onChangePickup;

  const BookingNoticeCard({
    super.key,
    required this.notice,
    this.onSearchAgain,
    this.onChangePickup,
  });

  @override
  Widget build(BuildContext context) {
    final isError = notice.isError;
    final surface = isError ? AppColors.errorLight : AppColors.infoSurface;
    final accent = isError ? AppColors.error : AppColors.info;
    final borderColor =
        isError ? AppColors.error.withOpacity(0.28) : AppColors.infoBorder;

    final showSearchAgain = notice.canSearchAgain && onSearchAgain != null;
    final showChangePickup = notice.canChangePickup && onChangePickup != null;

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 14),
      decoration: BoxDecoration(
        color: surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: borderColor),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // The whole message is one leaf semantics node: the icon and the two
          // text runs are excluded so a screen reader announces the outcome
          // once, tone first, instead of reading three fragments.
          Semantics(
            container: true,
            liveRegion: true,
            label: notice.semanticsLabel,
            excludeSemantics: true,
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 36,
                  height: 36,
                  decoration: BoxDecoration(
                    color: accent.withOpacity(0.12),
                    borderRadius: BorderRadius.circular(11),
                  ),
                  child: Icon(notice.icon, size: 20, color: accent),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        notice.title,
                        style: AppTextStyles.body(
                          color: isError ? AppColors.error : AppColors.charcoal,
                          weight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(height: 3),
                      Text(
                        notice.body,
                        style: AppTextStyles.bodySmall(
                          color:
                              isError ? AppColors.error : AppColors.darkGray,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          if (showSearchAgain || showChangePickup) ...[
            const SizedBox(height: 14),
            if (showSearchAgain)
              Semantics(
                button: true,
                label: 'Search again for a nearby Keke',
                excludeSemantics: true,
                child: SizedBox(
                  height: 48,
                  child: ElevatedButton.icon(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: AppColors.primary,
                      foregroundColor: AppColors.charcoal,
                      elevation: 0,
                      shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(13)),
                    ),
                    onPressed: onSearchAgain,
                    icon: const Icon(Icons.refresh_rounded, size: 18),
                    label: const Text('Search Again'),
                  ),
                ),
              ),
            if (showSearchAgain && showChangePickup) const SizedBox(height: 8),
            if (showChangePickup)
              Semantics(
                button: true,
                label: 'Change your pickup point',
                excludeSemantics: true,
                child: SizedBox(
                  height: 44,
                  child: TextButton.icon(
                    style: TextButton.styleFrom(
                      foregroundColor:
                          isError ? AppColors.error : AppColors.info,
                      shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(13)),
                    ),
                    onPressed: onChangePickup,
                    icon: const Icon(Icons.edit_location_alt_outlined, size: 18),
                    label: const Text('Change pickup point'),
                  ),
                ),
              ),
          ],
        ],
      ),
    );
  }
}
