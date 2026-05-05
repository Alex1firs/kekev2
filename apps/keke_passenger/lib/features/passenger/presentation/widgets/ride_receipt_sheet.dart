import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import '../../../../../core/theme/app_theme.dart';
import '../../application/booking_controller.dart';

class RideReceiptSheet extends ConsumerWidget {
  const RideReceiptSheet({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(bookingControllerProvider);

    final fare = state.receiptFare ?? 0;
    final driver = state.receiptDriver;
    final completedAt = state.receiptCompletedAt ?? DateTime.now();
    final isCash = (state.receiptPaymentMethod ?? 'cash') == 'cash';
    final timeStr = DateFormat('hh:mm a').format(completedAt);
    final dateStr = DateFormat('EEE, d MMM yyyy').format(completedAt);

    return Container(
      decoration: const BoxDecoration(
        color: AppColors.white,
        borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
      ),
      child: SafeArea(
        top: false,
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(24, 16, 24, 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Handle
              Center(
                child: Container(
                  width: 36,
                  height: 4,
                  margin: const EdgeInsets.only(bottom: 20),
                  decoration: BoxDecoration(
                    color: AppColors.border,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),

              // Success icon + heading
              Center(
                child: Container(
                  width: 64,
                  height: 64,
                  decoration: const BoxDecoration(
                    color: AppColors.primaryLight,
                    shape: BoxShape.circle,
                  ),
                  child: const Icon(
                    Icons.check_rounded,
                    color: AppColors.primaryDark,
                    size: 36,
                  ),
                ),
              ),
              const SizedBox(height: 14),
              Text(
                'Trip Complete!',
                textAlign: TextAlign.center,
                style: AppTextStyles.headline(
                    color: AppColors.charcoal, weight: FontWeight.w800),
              ),
              const SizedBox(height: 4),
              Text(
                '$dateStr · $timeStr',
                textAlign: TextAlign.center,
                style: AppTextStyles.bodySmall(color: AppColors.midGray),
              ),

              const SizedBox(height: 24),
              const _Divider(),

              // Fare highlight
              Container(
                padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 20),
                decoration: BoxDecoration(
                  color: AppColors.paleGray,
                  borderRadius: BorderRadius.circular(16),
                ),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Total Fare',
                            style: AppTextStyles.caption(color: AppColors.midGray)),
                        Text(
                          '₦${NumberFormat('#,###').format(fare)}',
                          style: AppTextStyles.display(
                              color: AppColors.charcoal, weight: FontWeight.w800),
                        ),
                      ],
                    ),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
                      decoration: BoxDecoration(
                        color: isCash
                            ? const Color(0xFFFEF9C3)
                            : AppColors.primaryLight,
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: Row(
                        children: [
                          Icon(
                            isCash
                                ? Icons.money_rounded
                                : Icons.account_balance_wallet_outlined,
                            size: 16,
                            color: isCash
                                ? const Color(0xFF92400E)
                                : AppColors.primaryDark,
                          ),
                          const SizedBox(width: 6),
                          Text(
                            isCash ? 'Cash' : 'Wallet',
                            style: AppTextStyles.bodySmall(
                              color: isCash
                                  ? const Color(0xFF92400E)
                                  : AppColors.primaryDark,
                              weight: FontWeight.w700,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),

              const SizedBox(height: 16),
              const _Divider(),
              const SizedBox(height: 4),

              // Route
              _RouteSection(
                pickup: state.receiptPickupAddress ?? '—',
                destination: state.receiptDestinationAddress ?? '—',
                distance: state.receiptDistance,
              ),

              const SizedBox(height: 4),
              const _Divider(),

              // Driver card
              if (driver != null) ...[
                const SizedBox(height: 12),
                Row(
                  children: [
                    Container(
                      width: 44,
                      height: 44,
                      decoration: const BoxDecoration(
                        color: AppColors.paleGray,
                        shape: BoxShape.circle,
                      ),
                      child: const Icon(Icons.electric_rickshaw,
                          color: AppColors.midGray, size: 22),
                    ),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            driver['name'] ?? 'Driver',
                            style: AppTextStyles.body(
                                color: AppColors.charcoal,
                                weight: FontWeight.w600),
                          ),
                          Text(
                            [
                              driver['vehicleModel'],
                              driver['vehiclePlate'],
                            ]
                                .where((v) => v != null && v.toString().isNotEmpty)
                                .join(' · '),
                            style: AppTextStyles.bodySmall(color: AppColors.midGray),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                const _Divider(),
              ],

              const SizedBox(height: 20),

              ElevatedButton(
                style: ElevatedButton.styleFrom(
                  backgroundColor: AppColors.primary,
                  foregroundColor: AppColors.charcoal,
                  padding: const EdgeInsets.symmetric(vertical: 18),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(16),
                  ),
                  elevation: 0,
                ),
                onPressed: () =>
                    ref.read(bookingControllerProvider.notifier).dismissReceipt(),
                child: Text(
                  'Done',
                  style: AppTextStyles.body(
                      color: AppColors.charcoal, weight: FontWeight.w700),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Divider extends StatelessWidget {
  const _Divider();

  @override
  Widget build(BuildContext context) {
    return const Divider(height: 1, color: AppColors.border);
  }
}

class _RouteSection extends StatelessWidget {
  final String pickup;
  final String destination;
  final String? distance;

  const _RouteSection({
    required this.pickup,
    required this.destination,
    this.distance,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
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
              Container(width: 2, height: 36, color: AppColors.border),
              Container(
                width: 10,
                height: 10,
                decoration: const BoxDecoration(
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
                  style: AppTextStyles.body(
                      color: AppColors.charcoal, weight: FontWeight.w500),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 18),
                Text(
                  destination,
                  style: AppTextStyles.body(
                      color: AppColors.darkGray, weight: FontWeight.w500),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                if (distance != null) ...[
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      const Icon(Icons.straighten_rounded,
                          size: 14, color: AppColors.midGray),
                      const SizedBox(width: 4),
                      Text(distance!,
                          style: AppTextStyles.caption(color: AppColors.midGray)),
                    ],
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}
