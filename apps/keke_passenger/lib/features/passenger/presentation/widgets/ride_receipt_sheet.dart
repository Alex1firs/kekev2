import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import '../../../../../core/theme/app_theme.dart';
import '../../application/booking_controller.dart';

class RideReceiptSheet extends ConsumerStatefulWidget {
  const RideReceiptSheet({super.key});

  @override
  ConsumerState<RideReceiptSheet> createState() => _RideReceiptSheetState();
}

class _RideReceiptSheetState extends ConsumerState<RideReceiptSheet>
    with SingleTickerProviderStateMixin {
  late AnimationController _ctrl;
  late Animation<double> _checkScale;
  late Animation<double> _fadeIn;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
        vsync: this, duration: const Duration(milliseconds: 800));
    _checkScale = Tween<double>(begin: 0.0, end: 1.0).animate(
      CurvedAnimation(parent: _ctrl, curve: const Interval(0.0, 0.6, curve: Curves.elasticOut)),
    );
    _fadeIn = Tween<double>(begin: 0.0, end: 1.0).animate(
      CurvedAnimation(parent: _ctrl, curve: const Interval(0.4, 1.0, curve: Curves.easeOut)),
    );
    _ctrl.forward();
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
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
                  width: 40,
                  height: 4,
                  margin: const EdgeInsets.only(bottom: 24),
                  decoration: BoxDecoration(
                    color: AppColors.border,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),

              // Success check animation
              Center(
                child: ScaleTransition(
                  scale: _checkScale,
                  child: Container(
                    width: 72,
                    height: 72,
                    decoration: BoxDecoration(
                      color: AppColors.primary,
                      shape: BoxShape.circle,
                      boxShadow: [
                        BoxShadow(
                          color: AppColors.primary.withOpacity(0.35),
                          blurRadius: 20,
                          offset: const Offset(0, 6),
                        ),
                      ],
                    ),
                    child: const Icon(Icons.check_rounded,
                        color: AppColors.charcoal, size: 40),
                  ),
                ),
              ),
              const SizedBox(height: 16),

              FadeTransition(
                opacity: _fadeIn,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
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

                    // Fare card
                    Container(
                      padding: const EdgeInsets.all(20),
                      decoration: BoxDecoration(
                        color: AppColors.charcoal,
                        borderRadius: BorderRadius.circular(20),
                        boxShadow: const [
                          BoxShadow(
                              color: Color(0x20000000),
                              blurRadius: 16,
                              offset: Offset(0, 4)),
                        ],
                      ),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text('Total Fare',
                                  style: AppTextStyles.caption(
                                      color: AppColors.midGray)),
                              const SizedBox(height: 4),
                              Text(
                                '₦${NumberFormat('#,###').format(fare)}',
                                style: AppTextStyles.display(
                                    color: AppColors.primary,
                                    weight: FontWeight.w800),
                              ),
                            ],
                          ),
                          Container(
                            padding: const EdgeInsets.symmetric(
                                horizontal: 14, vertical: 8),
                            decoration: BoxDecoration(
                              color: isCash
                                  ? const Color(0xFF2A2200)
                                  : AppColors.primary.withOpacity(0.2),
                              borderRadius: BorderRadius.circular(12),
                              border: Border.all(
                                color: isCash
                                    ? AppColors.primary.withOpacity(0.3)
                                    : AppColors.primary.withOpacity(0.5),
                              ),
                            ),
                            child: Row(
                              children: [
                                Icon(
                                  isCash
                                      ? Icons.payments_outlined
                                      : Icons.account_balance_wallet_outlined,
                                  size: 16,
                                  color: AppColors.primary,
                                ),
                                const SizedBox(width: 6),
                                Text(
                                  isCash ? 'Cash' : 'Wallet',
                                  style: AppTextStyles.bodySmall(
                                    color: AppColors.primary,
                                    weight: FontWeight.w700,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),

                    const SizedBox(height: 20),
                    const _Divider(),

                    // Route
                    _RouteSection(
                      pickup: state.receiptPickupAddress ?? '—',
                      destination: state.receiptDestinationAddress ?? '—',
                      distance: state.receiptDistance,
                    ),

                    const _Divider(),

                    // Driver summary
                    if (driver != null) ...[
                      const SizedBox(height: 14),
                      Row(
                        children: [
                          Container(
                            width: 46,
                            height: 46,
                            decoration: const BoxDecoration(
                              color: AppColors.primary,
                              shape: BoxShape.circle,
                            ),
                            child: Center(
                              child: Text(
                                (driver['name'] as String? ?? 'D')
                                    .substring(0, 1)
                                    .toUpperCase(),
                                style: AppTextStyles.title(
                                    color: AppColors.charcoal,
                                    weight: FontWeight.w800),
                              ),
                            ),
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
                                  [driver['vehicleModel'], driver['vehiclePlate']]
                                      .where((v) =>
                                          v != null && v.toString().isNotEmpty)
                                      .join(' · '),
                                  style:
                                      AppTextStyles.bodySmall(color: AppColors.midGray),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 14),
                      const _Divider(),
                    ],

                    const SizedBox(height: 24),

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
                      onPressed: () => ref
                          .read(bookingControllerProvider.notifier)
                          .dismissReceipt(),
                      child: Text('Done',
                          style: AppTextStyles.button(color: AppColors.charcoal)),
                    ),
                  ],
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
      padding: const EdgeInsets.symmetric(vertical: 14),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Column(
            children: [
              Container(
                width: 10,
                height: 10,
                decoration: const BoxDecoration(
                    color: AppColors.primary, shape: BoxShape.circle),
              ),
              Container(width: 2, height: 38, color: AppColors.border),
              Container(
                width: 10,
                height: 10,
                decoration: const BoxDecoration(
                    color: AppColors.error, shape: BoxShape.circle),
              ),
            ],
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(pickup,
                    style: AppTextStyles.body(
                        color: AppColors.charcoal, weight: FontWeight.w500),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis),
                const SizedBox(height: 20),
                Text(destination,
                    style: AppTextStyles.body(
                        color: AppColors.darkGray, weight: FontWeight.w500),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis),
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
