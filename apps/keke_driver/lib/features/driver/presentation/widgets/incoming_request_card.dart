import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
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
    return Positioned(
      bottom: 40,
      left: 20,
      right: 20,
      child: Container(
        padding: const EdgeInsets.all(24),
        decoration: BoxDecoration(
          color: Colors.black.withOpacity(0.95),
          borderRadius: BorderRadius.circular(24),
          border: Border.all(color: Colors.amber.shade700, width: 2),
          boxShadow: [BoxShadow(color: Colors.black54, blurRadius: 20)],
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                const Text('NEW RIDE REQUEST', style: TextStyle(color: Colors.amber, fontWeight: FontWeight.bold, letterSpacing: 1.2)),
                Text('${countdown}s', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 18)),
              ],
            ),
            const SizedBox(height: 12),
            LinearProgressIndicator(
              value: countdown / 30, // Assuming 30s max
              backgroundColor: Colors.grey.shade900,
              valueColor: const AlwaysStoppedAnimation<Color>(Colors.amber),
            ),
            const SizedBox(height: 24),
            Row(
              children: [
                const Icon(Icons.person, color: Colors.white70),
                const SizedBox(width: 12),
                Text(request.passengerName, style: const TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.bold)),
                const Spacer(),
                Text('₦${request.fare.toInt()}', style: const TextStyle(color: Colors.white, fontSize: 24, fontWeight: FontWeight.bold)),
              ],
            ),
            const Divider(color: Colors.white24, height: 32),
            _buildLocationRow(Icons.circle, Colors.amber, request.pickupAddress),
            const SizedBox(height: 12),
            _buildLocationRow(Icons.location_on, Colors.redAccent, request.destinationAddress),
            const SizedBox(height: 32),
            Row(
              children: [
                Expanded(
                  child: TextButton(
                    onPressed: () => ref.read(driverControllerProvider.notifier).rejectRequest(),
                    child: const Text('REJECT', style: TextStyle(color: Colors.redAccent, fontWeight: FontWeight.bold)),
                  ),
                ),
                const SizedBox(width: 16),
                Expanded(
                  flex: 2,
                  child: ElevatedButton(
                    style: ElevatedButton.styleFrom(backgroundColor: Colors.amber, foregroundColor: Colors.black),
                    onPressed: () => ref.read(driverControllerProvider.notifier).acceptRequest(),
                    child: const Padding(
                      padding: EdgeInsets.symmetric(vertical: 12.0),
                      child: Text('ACCEPT RIDE', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                    ),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildLocationRow(IconData icon, Color color, String address) {
    return Row(
      children: [
        Icon(icon, color: color, size: 16),
        const SizedBox(width: 12),
        Expanded(
          child: Text(
            address,
            style: const TextStyle(color: Colors.white70, fontSize: 14),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ),
      ],
    );
  }
}
