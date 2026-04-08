import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../application/driver_controller.dart';
import '../../domain/driver_profile.dart';
import '../../domain/driver_state.dart';

class TripOperationHUD extends ConsumerWidget {
  final DriverState state;

  const TripOperationHUD({
    super.key,
    required this.state,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (state.activeRequest == null) return const SizedBox.shrink();

    return Positioned(
      bottom: 0,
      left: 0,
      right: 0,
      child: Container(
        padding: const EdgeInsets.all(24),
        decoration: BoxDecoration(
          color: Colors.black,
          border: Border(top: BorderSide(color: Colors.amber.shade900, width: 3)),
          borderRadius: const BorderRadius.only(topLeft: Radius.circular(32), topRight: Radius.circular(32)),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _buildTripHeader(),
            const SizedBox(height: 24),
            _buildMainAction(ref),
            const SizedBox(height: 16),
            _buildPaxDetails(),
            if (state.tripStep == TripStep.completed)
               _buildCompletionButton(ref),
          ],
        ),
      ),
    );
  }

  Widget _buildTripHeader() {
    String title = '';
    Color color = Colors.white;

    switch (state.tripStep) {
      case TripStep.accepted:
        title = 'NAVIGATING TO PICKUP';
        color = Colors.blueAccent;
        break;
      case TripStep.arrived:
        title = 'WAITING AT PICKUP';
        color = Colors.amber;
        break;
      case TripStep.started:
        title = 'ON TRIP TO DESTINATION';
        color = Colors.greenAccent;
        break;
      case TripStep.completed:
        title = 'TRIP COMPLETED';
        color = Colors.white;
        break;
      default:
        title = '';
    }

    return Column(
      children: [
        Text(title, style: TextStyle(color: color, fontWeight: FontWeight.bold, letterSpacing: 1.5, fontSize: 16)),
        const SizedBox(height: 8),
        Text(
          state.tripStep == TripStep.started ? state.activeRequest!.destinationAddress : state.activeRequest!.pickupAddress,
          style: const TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.bold),
          textAlign: TextAlign.center,
        ),
      ],
    );
  }

  Widget _buildMainAction(WidgetRef ref) {
    String text = '';
    VoidCallback? onPressed;
    Color color = Colors.amber;

    switch (state.tripStep) {
      case TripStep.accepted:
        text = 'I HAVE ARRIVED';
        onPressed = () => ref.read(driverControllerProvider.notifier).markArrived();
        break;
      case TripStep.arrived:
        text = 'START TRIP';
        onPressed = () => ref.read(driverControllerProvider.notifier).startTrip();
        break;
      case TripStep.started:
        text = 'END TRIP';
        color = Colors.redAccent;
        onPressed = () => ref.read(driverControllerProvider.notifier).completeTrip();
        break;
      default:
        return const SizedBox.shrink();
    }

    return ElevatedButton(
      style: ElevatedButton.styleFrom(
        backgroundColor: color,
        foregroundColor: Colors.black,
        padding: const EdgeInsets.symmetric(vertical: 20),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      ),
      onPressed: onPressed,
      child: Text(text, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
    );
  }

  Widget _buildPaxDetails() {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        CircleAvatar(backgroundColor: Colors.grey.shade900, child: const Icon(Icons.person, color: Colors.white)),
        const SizedBox(width: 16),
        Text(state.activeRequest!.passengerName, style: const TextStyle(color: Colors.white, fontSize: 18)),
        const SizedBox(width: 24),
        IconButton(
          onPressed: () {},
          icon: const Icon(Icons.call, color: Colors.greenAccent),
        ),
      ],
    );
  }

  Widget _buildCompletionButton(WidgetRef ref) {
    return Column(
      children: [
        const Text('Fare Captured Successfully', style: TextStyle(color: Colors.green, fontWeight: FontWeight.bold)),
        const SizedBox(height: 16),
        ElevatedButton(
          style: ElevatedButton.styleFrom(backgroundColor: Colors.white, foregroundColor: Colors.black),
          onPressed: () => ref.read(driverControllerProvider.notifier).finishAndGoAvailable(),
          child: const Text('Back to Available'),
        ),
      ],
    );
  }
}
