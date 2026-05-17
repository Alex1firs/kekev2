import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../../../core/theme/app_theme.dart';
import '../../application/driver_controller.dart';
import '../../domain/trip_request.dart';

class IncomingRequestCard extends ConsumerStatefulWidget {
  final TripRequest request;
  final int countdown;

  const IncomingRequestCard({
    super.key,
    required this.request,
    required this.countdown,
  });

  @override
  ConsumerState<IncomingRequestCard> createState() =>
      _IncomingRequestCardState();
}

class _IncomingRequestCardState extends ConsumerState<IncomingRequestCard>
    with SingleTickerProviderStateMixin {
  late final AnimationController _entry;
  late final Animation<Offset> _slide;
  late final Animation<double> _fade;

  @override
  void initState() {
    super.initState();
    HapticFeedback.heavyImpact();
    _entry = AnimationController(
        vsync: this, duration: const Duration(milliseconds: 360));
    _slide = Tween<Offset>(begin: const Offset(0, 1), end: Offset.zero)
        .animate(CurvedAnimation(parent: _entry, curve: Curves.easeOutCubic));
    _fade = CurvedAnimation(
        parent: _entry,
        curve: const Interval(0.1, 1.0, curve: Curves.easeIn));
    _entry.forward();
  }

  @override
  void dispose() {
    _entry.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final progress = (widget.countdown / 30).clamp(0.0, 1.0);
    final isUrgent = widget.countdown <= 10;
    final accentColor = isUrgent ? AppColors.error : AppColors.primary;

    return Positioned(
      bottom: 0,
      left: 0,
      right: 0,
      child: SlideTransition(
        position: _slide,
        child: FadeTransition(
          opacity: _fade,
          child: Container(
            decoration: const BoxDecoration(
              color: AppColors.charcoal,
              borderRadius: BorderRadius.only(
                topLeft: Radius.circular(28),
                topRight: Radius.circular(28),
              ),
              boxShadow: [
                BoxShadow(
                    color: Color(0x55000000),
                    blurRadius: 28,
                    offset: Offset(0, -6)),
              ],
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                // Countdown progress strip
                ClipRRect(
                  borderRadius: const BorderRadius.only(
                    topLeft: Radius.circular(28),
                    topRight: Radius.circular(28),
                  ),
                  child: LinearProgressIndicator(
                    value: progress,
                    minHeight: 5,
                    backgroundColor: AppColors.darkGray,
                    valueColor: AlwaysStoppedAnimation<Color>(accentColor),
                  ),
                ),

                Padding(
                  padding: const EdgeInsets.fromLTRB(24, 16, 24, 32),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      // Header: badges + countdown ring
                      Row(
                        children: [
                          Container(
                            padding: const EdgeInsets.symmetric(
                                horizontal: 10, vertical: 5),
                            decoration: BoxDecoration(
                              color: AppColors.primary,
                              borderRadius: BorderRadius.circular(8),
                            ),
                            child: Text(
                              'NEW RIDE',
                              style: AppTextStyles.caption(
                                color: AppColors.charcoal,
                                weight: FontWeight.w800,
                              ),
                            ),
                          ),
                          const SizedBox(width: 8),
                          _PaymentBadge(isCash: widget.request.isCash),
                          const Spacer(),
                          _CountdownRing(
                            countdown: widget.countdown,
                            progress: progress,
                            accentColor: accentColor,
                          ),
                        ],
                      ),
                      const SizedBox(height: 20),

                      // Fare (hero) + passenger name
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.center,
                        children: [
                          Text(
                            '₦${widget.request.fare.toInt()}',
                            style: AppTextStyles.display(
                              color: AppColors.primary,
                              weight: FontWeight.w800,
                            ),
                          ),
                          const SizedBox(width: 14),
                          Expanded(
                            child: Row(
                              children: [
                                Container(
                                  width: 36,
                                  height: 36,
                                  decoration: const BoxDecoration(
                                    color: AppColors.darkGray,
                                    shape: BoxShape.circle,
                                  ),
                                  child: const Icon(Icons.person,
                                      color: AppColors.lightGray, size: 18),
                                ),
                                const SizedBox(width: 8),
                                Expanded(
                                  child: Text(
                                    widget.request.passengerName,
                                    style: AppTextStyles.body(
                                        color: AppColors.white,
                                        weight: FontWeight.w600),
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 18),

                      // Route visualization
                      _RouteCard(
                        pickup: widget.request.pickupAddress,
                        destination: widget.request.destinationAddress,
                      ),
                      const SizedBox(height: 22),

                      // Action buttons
                      Row(
                        children: [
                          Expanded(
                            child: OutlinedButton(
                              style: OutlinedButton.styleFrom(
                                foregroundColor: AppColors.error,
                                side: const BorderSide(
                                    color: AppColors.error, width: 1.5),
                                padding:
                                    const EdgeInsets.symmetric(vertical: 18),
                                shape: RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(14),
                                ),
                              ),
                              onPressed: () => ref
                                  .read(driverControllerProvider.notifier)
                                  .rejectRequest(),
                              child: Text(
                                'Decline',
                                style: AppTextStyles.body(
                                    color: AppColors.error,
                                    weight: FontWeight.w700),
                              ),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            flex: 2,
                            child: ElevatedButton(
                              style: ElevatedButton.styleFrom(
                                backgroundColor: AppColors.primary,
                                foregroundColor: AppColors.charcoal,
                                padding:
                                    const EdgeInsets.symmetric(vertical: 18),
                                shape: RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(14),
                                ),
                                elevation: 0,
                              ),
                              onPressed: () => ref
                                  .read(driverControllerProvider.notifier)
                                  .acceptRequest(),
                              child: Row(
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: [
                                  const Icon(Icons.electric_rickshaw, size: 22),
                                  const SizedBox(width: 8),
                                  Text(
                                    'Accept Ride',
                                    style: AppTextStyles.body(
                                      color: AppColors.charcoal,
                                      weight: FontWeight.w800,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _CountdownRing extends StatelessWidget {
  final int countdown;
  final double progress;
  final Color accentColor;

  const _CountdownRing({
    required this.countdown,
    required this.progress,
    required this.accentColor,
  });

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 64,
      height: 64,
      child: Stack(
        alignment: Alignment.center,
        children: [
          CircularProgressIndicator(
            value: progress,
            strokeWidth: 4,
            backgroundColor: AppColors.darkGray,
            valueColor: AlwaysStoppedAnimation<Color>(accentColor),
          ),
          Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                '$countdown',
                style: AppTextStyles.title(
                    color: accentColor, weight: FontWeight.w800),
              ),
              Text('s', style: AppTextStyles.caption(color: AppColors.midGray)),
            ],
          ),
        ],
      ),
    );
  }
}

class _PaymentBadge extends StatelessWidget {
  final bool isCash;
  const _PaymentBadge({required this.isCash});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
      decoration: BoxDecoration(
        color: isCash ? const Color(0xFF065F46) : AppColors.darkGray,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        isCash ? 'CASH' : 'WALLET',
        style: AppTextStyles.caption(
          color: isCash ? const Color(0xFF6EE7B7) : AppColors.lightGray,
          weight: FontWeight.w700,
        ),
      ),
    );
  }
}

class _RouteCard extends StatelessWidget {
  final String pickup;
  final String destination;

  const _RouteCard({required this.pickup, required this.destination});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: AppColors.darkGray,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Column(
            children: [
              Container(
                width: 12,
                height: 12,
                decoration: const BoxDecoration(
                  color: AppColors.primary,
                  shape: BoxShape.circle,
                ),
              ),
              Container(width: 2, height: 28, color: AppColors.border),
              Container(
                width: 12,
                height: 12,
                decoration: BoxDecoration(
                  border: Border.all(color: AppColors.error, width: 2),
                  shape: BoxShape.circle,
                ),
              ),
            ],
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  pickup.isNotEmpty ? pickup : 'Pickup location',
                  style: AppTextStyles.body(
                      color: AppColors.white, weight: FontWeight.w600),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 16),
                Text(
                  destination.isNotEmpty ? destination : 'Destination',
                  style: AppTextStyles.body(color: AppColors.lightGray),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
