import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../../../core/theme/app_theme.dart';
import '../../application/driver_controller.dart';
import '../../domain/trip_request.dart';

class IncomingRequestCard extends ConsumerWidget {
  final TripRequest request;
  final int countdown;

  const IncomingRequestCard({
    super.key,
    required this.request,
    required this.countdown,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final progress = (countdown / 30).clamp(0.0, 1.0);

    return Positioned(
      bottom: 0,
      left: 0,
      right: 0,
      child: Container(
        decoration: const BoxDecoration(
          color: AppColors.charcoal,
          borderRadius: BorderRadius.only(
            topLeft: Radius.circular(28),
            topRight: Radius.circular(28),
          ),
          boxShadow: [
            BoxShadow(color: Color(0x44000000), blurRadius: 24, offset: Offset(0, -4)),
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
                minHeight: 4,
                backgroundColor: AppColors.darkGray,
                valueColor: AlwaysStoppedAnimation<Color>(
                  progress > 0.5 ? AppColors.primary : AppColors.error,
                ),
              ),
            ),

            Padding(
              padding: const EdgeInsets.fromLTRB(24, 20, 24, 28),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // Header
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Row(
                        children: [
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                            decoration: BoxDecoration(
                              color: AppColors.primaryLight,
                              borderRadius: BorderRadius.circular(8),
                            ),
                            child: Text(
                              'NEW REQUEST',
                              style: AppTextStyles.caption(
                                color: AppColors.primaryDark,
                                weight: FontWeight.w700,
                              ),
                            ),
                          ),
                          const SizedBox(width: 10),
                          if (request.isCash)
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
                              decoration: BoxDecoration(
                                color: const Color(0xFF065F46),
                                borderRadius: BorderRadius.circular(8),
                              ),
                              child: Text(
                                'CASH',
                                style: AppTextStyles.caption(
                                  color: const Color(0xFF6EE7B7),
                                  weight: FontWeight.w700,
                                ),
                              ),
                            )
                          else
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
                              decoration: BoxDecoration(
                                color: AppColors.darkGray,
                                borderRadius: BorderRadius.circular(8),
                              ),
                              child: Text(
                                'WALLET',
                                style: AppTextStyles.caption(
                                  color: AppColors.lightGray,
                                  weight: FontWeight.w700,
                                ),
                              ),
                            ),
                        ],
                      ),
                      // Countdown
                      Container(
                        width: 48,
                        height: 48,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          border: Border.all(
                            color: progress > 0.5 ? AppColors.primary : AppColors.error,
                            width: 2,
                          ),
                        ),
                        child: Center(
                          child: Text(
                            '${countdown}s',
                            style: AppTextStyles.bodySmall(
                              color: AppColors.white,
                              weight: FontWeight.w700,
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 20),

                  // Passenger + Fare
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.center,
                    children: [
                      Container(
                        width: 44,
                        height: 44,
                        decoration: BoxDecoration(
                          color: AppColors.darkGray,
                          shape: BoxShape.circle,
                        ),
                        child: const Icon(Icons.person, color: AppColors.lightGray, size: 22),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Text(
                          request.passengerName,
                          style: AppTextStyles.title(color: AppColors.white),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      Text(
                        '₦${request.fare.toInt()}',
                        style: AppTextStyles.display(
                          color: AppColors.primary,
                          weight: FontWeight.w800,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 20),

                  // Route
                  _RouteColumn(
                    pickup: request.pickupAddress,
                    destination: request.destinationAddress,
                  ),
                  const SizedBox(height: 24),

                  // Actions
                  Row(
                    children: [
                      Expanded(
                        child: OutlinedButton(
                          style: OutlinedButton.styleFrom(
                            foregroundColor: AppColors.error,
                            side: const BorderSide(color: AppColors.error),
                            padding: const EdgeInsets.symmetric(vertical: 16),
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(14),
                            ),
                          ),
                          onPressed: () =>
                              ref.read(driverControllerProvider.notifier).rejectRequest(),
                          child: Text('Decline', style: AppTextStyles.body(color: AppColors.error, weight: FontWeight.w700)),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        flex: 2,
                        child: ElevatedButton(
                          style: ElevatedButton.styleFrom(
                            backgroundColor: AppColors.primary,
                            foregroundColor: AppColors.charcoal,
                            padding: const EdgeInsets.symmetric(vertical: 16),
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(14),
                            ),
                            elevation: 0,
                          ),
                          onPressed: () =>
                              ref.read(driverControllerProvider.notifier).acceptRequest(),
                          child: Row(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              const Icon(Icons.electric_rickshaw, size: 20),
                              const SizedBox(width: 8),
                              Text(
                                'Accept Ride',
                                style: AppTextStyles.body(
                                  color: AppColors.charcoal,
                                  weight: FontWeight.w700,
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
    );
  }
}

class _RouteColumn extends StatelessWidget {
  final String pickup;
  final String destination;

  const _RouteColumn({required this.pickup, required this.destination});

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Route spine
        Column(
          children: [
            Container(
              width: 10,
              height: 10,
              decoration: const BoxDecoration(
                color: AppColors.primary,
                shape: BoxShape.circle,
              ),
            ),
            Container(width: 2, height: 30, color: AppColors.darkGray),
            Container(
              width: 10,
              height: 10,
              decoration: BoxDecoration(
                color: AppColors.error,
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
                pickup,
                style: AppTextStyles.body(color: AppColors.white),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              const SizedBox(height: 16),
              Text(
                destination,
                style: AppTextStyles.body(color: AppColors.lightGray),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ),
        ),
      ],
    );
  }
}
