import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import '../../application/booking_controller.dart';
import '../../domain/booking_state.dart';

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
        color: Colors.white,
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      child: SafeArea(
        top: false,
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Handle
              Center(
                child: Container(
                  width: 40, height: 4,
                  margin: const EdgeInsets.only(bottom: 20),
                  decoration: BoxDecoration(color: Colors.grey[300], borderRadius: BorderRadius.circular(2)),
                ),
              ),

              // Success icon + heading
              const Center(
                child: CircleAvatar(
                  radius: 32,
                  backgroundColor: Color(0xFFFFC107),
                  child: Icon(Icons.check, color: Colors.black, size: 36),
                ),
              ),
              const SizedBox(height: 12),
              const Center(
                child: Text('Trip Completed!',
                    style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
              ),
              Center(
                child: Text('$dateStr · $timeStr',
                    style: TextStyle(color: Colors.grey[600], fontSize: 13)),
              ),

              const SizedBox(height: 24),
              const Divider(),

              // Fare
              _ReceiptRow(
                icon: Icons.payments_outlined,
                label: 'Total Fare',
                value: '₦${NumberFormat('#,###').format(fare)}',
                valueStyle: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
              ),
              _ReceiptRow(
                icon: isCash ? Icons.money : Icons.account_balance_wallet_outlined,
                label: 'Payment',
                value: isCash ? 'Cash' : 'Wallet',
              ),

              const Divider(),

              // Route
              _RouteRow(
                pickup: state.receiptPickupAddress ?? '—',
                destination: state.receiptDestinationAddress ?? '—',
              ),

              if (state.receiptDistance != null) ...[
                const SizedBox(height: 4),
                Row(
                  children: [
                    Icon(Icons.straighten, size: 16, color: Colors.grey[500]),
                    const SizedBox(width: 6),
                    Text(state.receiptDistance!,
                        style: TextStyle(color: Colors.grey[600], fontSize: 13)),
                  ],
                ),
              ],

              const Divider(),

              // Driver
              if (driver != null) ...[
                Row(
                  children: [
                    const CircleAvatar(
                      radius: 22,
                      backgroundColor: Color(0xFFF5F5F5),
                      child: Icon(Icons.person, color: Colors.black54),
                    ),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(driver['name'] ?? 'Driver',
                              style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15)),
                          Text(
                            '${driver['vehicleModel'] ?? ''} · ${driver['vehiclePlate'] ?? ''}'.trim().replaceAll(RegExp(r'^\s*·\s*|\s*·\s*$'), ''),
                            style: TextStyle(color: Colors.grey[600], fontSize: 13),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                const Divider(),
              ],

              const SizedBox(height: 8),

              // Done button
              ElevatedButton(
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFFFFC107),
                  foregroundColor: Colors.black,
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
                ),
                onPressed: () => ref.read(bookingControllerProvider.notifier).dismissReceipt(),
                child: const Text('Done', style: TextStyle(fontSize: 17, fontWeight: FontWeight.bold)),
              ),
              const SizedBox(height: 8),
            ],
          ),
        ),
      ),
    );
  }
}

class _ReceiptRow extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;
  final TextStyle? valueStyle;

  const _ReceiptRow({
    required this.icon,
    required this.label,
    required this.value,
    this.valueStyle,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Row(
        children: [
          Icon(icon, size: 20, color: Colors.grey[600]),
          const SizedBox(width: 12),
          Text(label, style: TextStyle(color: Colors.grey[700], fontSize: 14)),
          const Spacer(),
          Text(value, style: valueStyle ?? const TextStyle(fontWeight: FontWeight.w600, fontSize: 15)),
        ],
      ),
    );
  }
}

class _RouteRow extends StatelessWidget {
  final String pickup;
  final String destination;

  const _RouteRow({required this.pickup, required this.destination});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Column(
            children: [
              const Icon(Icons.radio_button_checked, size: 18, color: Color(0xFFFFC107)),
              Container(width: 2, height: 32, color: Colors.grey[300]),
              const Icon(Icons.location_on, size: 18, color: Colors.redAccent),
            ],
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(pickup,
                    style: const TextStyle(fontWeight: FontWeight.w500, fontSize: 14),
                    maxLines: 2, overflow: TextOverflow.ellipsis),
                const SizedBox(height: 16),
                Text(destination,
                    style: const TextStyle(fontWeight: FontWeight.w500, fontSize: 14),
                    maxLines: 2, overflow: TextOverflow.ellipsis),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
