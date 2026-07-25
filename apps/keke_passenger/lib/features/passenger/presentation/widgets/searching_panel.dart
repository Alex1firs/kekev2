import 'package:flutter/material.dart';

import '../../../../core/theme/app_theme.dart';
import '../../domain/booking_notice.dart';
import '../../domain/nearby_keke.dart';
import 'booking_notice_card.dart';

/// The "looking for a driver" sheet panel.
///
/// Extracted from `BookingSheet` so its copy is directly widget-testable
/// without standing up maps, sockets and the wallet provider.
class SearchingPanel extends StatelessWidget {
  /// 1-based dispatch round. >= 2 renders the second-round copy.
  final int searchRound;

  /// Transient, non-terminal message (e.g. socket dropped mid-search). Shown
  /// in error styling because it reports a real connectivity problem.
  final String? transientMessage;

  /// A non-terminal notice to surface above the animation, if any.
  final BookingNotice? notice;

  /// Nearby availability, so the reassurance does not depend on seeing the map.
  final NearbyKekeFeed nearbyKekes;

  final VoidCallback onCancel;

  const SearchingPanel({
    super.key,
    required this.onCancel,
    this.searchRound = 1,
    this.transientMessage,
    this.notice,
    this.nearbyKekes = NearbyKekeFeed.empty,
  });

  @override
  Widget build(BuildContext context) {
    final copy = SearchingCopy.of(searchRound);

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (notice != null) ...[
          const SizedBox(height: 4),
          BookingNoticeCard(notice: notice!),
          const SizedBox(height: 12),
        ] else if (transientMessage != null) ...[
          const SizedBox(height: 4),
          _TransientError(message: transientMessage!),
          const SizedBox(height: 12),
        ],

        const SizedBox(height: 8),
        const _KekeSearchAnimation(),
        const SizedBox(height: 20),

        // One live region for the whole status block, so a screen reader
        // announces the copy once — and again when the round changes.
        Semantics(
          container: true,
          liveRegion: true,
          label: '${copy.primary} ${copy.supporting}',
          child: ExcludeSemantics(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(copy.primary, style: AppTextStyles.title()),
                const SizedBox(height: 6),
                Text(
                  copy.supporting,
                  style: AppTextStyles.bodySmall(color: AppColors.midGray),
                  textAlign: TextAlign.center,
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 14),

        // Accessibility-safe alternative to the map markers: the same truthful
        // availability information as text, announced on change. A passenger
        // using a screen reader, or one who simply cannot see the map behind the
        // sheet, gets the identical signal.
        _NearbyAvailability(feed: nearbyKekes),

        const SizedBox(height: 20),

        Semantics(
          button: true,
          label: 'Cancel this ride request',
          excludeSemantics: true,
          child: OutlinedButton(
            style: OutlinedButton.styleFrom(
              foregroundColor: AppColors.error,
              side: const BorderSide(color: AppColors.error),
              minimumSize: const Size(double.infinity, 50),
              shape:
                  RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
            ),
            onPressed: onCancel,
            child: const Text('Cancel Request'),
          ),
        ),
        const SizedBox(height: 4),
      ],
    );
  }
}

/// Text equivalent of the nearby-Keke map markers.
///
/// Reports the server's honest eligible count — which may exceed the number of
/// markers drawn, since those are capped for privacy — and never claims a driver
/// has been contacted about this ride.
class _NearbyAvailability extends StatelessWidget {
  final NearbyKekeFeed feed;
  const _NearbyAvailability({required this.feed});

  @override
  Widget build(BuildContext context) {
    final hasSupply = feed.eligibleCount > 0;

    return Semantics(
      container: true,
      liveRegion: true,
      label: feed.accessibilitySummary,
      excludeSemantics: true,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: hasSupply ? AppColors.infoSurface : AppColors.paleGray,
          borderRadius: BorderRadius.circular(11),
          border: Border.all(
            color: hasSupply ? AppColors.infoBorder : AppColors.border,
          ),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              hasSupply ? Icons.electric_rickshaw : Icons.location_searching,
              size: 15,
              color: hasSupply ? AppColors.info : AppColors.midGray,
            ),
            const SizedBox(width: 7),
            Flexible(
              child: Text(
                feed.shortLabel,
                textAlign: TextAlign.center,
                style: AppTextStyles.caption(
                  color: hasSupply ? AppColors.darkGray : AppColors.midGray,
                  weight: FontWeight.w600,
                ),
              ),
            ),
            if (hasSupply && feed.approximateRadiusMeters > 0) ...[
              const SizedBox(width: 6),
              Text(
                '· approximate',
                style: AppTextStyles.caption(color: AppColors.lightGray),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Slim red strip for transient connectivity problems during a live search.
class _TransientError extends StatelessWidget {
  final String message;
  const _TransientError({required this.message});

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      liveRegion: true,
      label: 'Error. $message',
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: AppColors.errorLight,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: AppColors.error.withOpacity(0.3)),
        ),
        child: Row(
          children: [
            const ExcludeSemantics(
              child: Icon(Icons.wifi_off_rounded,
                  color: AppColors.error, size: 16),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: ExcludeSemantics(
                child: Text(message,
                    style: AppTextStyles.bodySmall(color: AppColors.error)),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ── Searching animation ────────────────────────────────────────────────────

class _KekeSearchAnimation extends StatefulWidget {
  const _KekeSearchAnimation();

  @override
  State<_KekeSearchAnimation> createState() => _KekeSearchAnimationState();
}

class _KekeSearchAnimationState extends State<_KekeSearchAnimation>
    with SingleTickerProviderStateMixin {
  late AnimationController _ctrl;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1600),
    )..repeat();
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 80,
      height: 80,
      child: Stack(
        alignment: Alignment.center,
        children: [
          // Outer ring
          AnimatedBuilder(
            animation: _ctrl,
            builder: (_, __) {
              final t = _ctrl.value;
              return Opacity(
                opacity: (1 - t).clamp(0.0, 1.0),
                child: Transform.scale(
                  scale: 0.5 + t * 0.8,
                  child: Container(
                    width: 80,
                    height: 80,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(
                        color: AppColors.primary.withOpacity(0.3),
                        width: 2,
                      ),
                    ),
                  ),
                ),
              );
            },
          ),
          // Middle ring
          AnimatedBuilder(
            animation: _ctrl,
            builder: (_, __) {
              final t = ((_ctrl.value + 0.35) % 1.0);
              return Opacity(
                opacity: (1 - t).clamp(0.0, 1.0),
                child: Transform.scale(
                  scale: 0.5 + t * 0.8,
                  child: Container(
                    width: 80,
                    height: 80,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(
                        color: AppColors.primary.withOpacity(0.45),
                        width: 2,
                      ),
                    ),
                  ),
                ),
              );
            },
          ),
          // Center icon
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(
              color: AppColors.primary,
              shape: BoxShape.circle,
              boxShadow: [
                BoxShadow(
                  color: AppColors.primary.withOpacity(0.4),
                  blurRadius: 12,
                  offset: const Offset(0, 3),
                ),
              ],
            ),
            child: const ExcludeSemantics(
              child: Icon(Icons.electric_rickshaw,
                  color: AppColors.charcoal, size: 24),
            ),
          ),
        ],
      ),
    );
  }
}
