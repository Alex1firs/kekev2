import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import '../application/driver_controller.dart';
import '../domain/driver_profile.dart';
import '../domain/driver_state.dart';
import 'widgets/incoming_request_card.dart';
import 'widgets/trip_operation_hud.dart';

class DriverHomeScreen extends ConsumerStatefulWidget {
  const DriverHomeScreen({super.key});

  @override
  ConsumerState<DriverHomeScreen> createState() => _DriverHomeScreenState();
}

class _DriverHomeScreenState extends ConsumerState<DriverHomeScreen> {
  GoogleMapController? _mapController;

  @override
  Widget build(BuildContext context) {
    final driverState = ref.watch(driverControllerProvider);
    final profile = driverState.profile;

    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        children: [
          // Map Background
          _buildMap(driverState),

          // Top Status Bar
          _buildStatusHeader(driverState),

          // Debt Warning Overlay
          if (profile.debtAmount > 0) _buildDebtWarning(profile.debtAmount),

          // Content Layer (Request or Trip HUD)
          if (driverState.activeRequest != null && driverState.tripStep == TripStep.none)
             IncomingRequestCard(request: driverState.activeRequest!, countdown: driverState.countdown ?? 30),
          
          if (driverState.tripStep != TripStep.none)
             TripOperationHUD(state: driverState),

          // Simulation FAB (For Phase 4 Demo)
          if (driverState.operationStatus == OperationStatus.available)
            Positioned(
              right: 20,
              bottom: 120,
              child: FloatingActionButton(
                backgroundColor: Colors.blueAccent,
                onPressed: () => ref.read(driverControllerProvider.notifier).simulateIncomingRequest(),
                child: const Icon(Icons.bolt, color: Colors.white),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildMap(DriverState state) {
    return Container(
      color: Colors.grey.shade900,
      child: GoogleMap(
        initialCameraPosition: const CameraPosition(target: LatLng(6.1264, 6.7876), zoom: 15),
        myLocationEnabled: true,
        myLocationButtonEnabled: false,
        onMapCreated: (controller) => _mapController = controller,
        mapType: MapType.normal,
      ),
    );
  }

  Widget _buildStatusHeader(DriverState state) {
    final isOnline = state.operationStatus != OperationStatus.offline;

    return Positioned(
      top: 50,
      left: 20,
      right: 20,
      child: Container(
        height: 70,
        decoration: BoxDecoration(
          color: isOnline ? Colors.green.shade900 : Colors.black87,
          borderRadius: BorderRadius.circular(35),
          border: Border.all(color: isOnline ? Colors.green : Colors.grey.shade800, width: 2),
        ),
        child: Row(
          children: [
            Padding(
              padding: const EdgeInsets.only(left: 20),
              child: IconButton(
                icon: const Icon(Icons.account_balance_wallet, color: Colors.white),
                onPressed: () {
                  // TODO: Implement EarningsScreen
                  ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Earnings screen coming soon')));
                },
              ),
            ),
            Expanded(
              child: Center(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Text(
                      isOnline ? 'ONLINE' : 'OFFLINE',
                      style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 18),
                    ),
                    if (isOnline) const Text('Searching for requests...', style: TextStyle(color: Colors.white70, fontSize: 12)),
                  ],
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.only(right: 10),
              child: Switch(
                value: isOnline,
                onChanged: (_) => ref.read(driverControllerProvider.notifier).toggleOnline(),
                activeColor: Colors.greenAccent,
                activeTrackColor: Colors.green.shade700,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildDebtWarning(double amount) {
    String message = '';
    Color color = Colors.amber;

    if (amount >= 5000) {
      message = 'HARD BLOCK: Pay ₦$amount to go online';
      color = Colors.red;
    } else if (amount >= 2000) {
      message = 'RESTRICTION WARNING: Debt ₦$amount too high';
      color = Colors.orange;
    } else {
      message = 'DEBT WARNING: Balance ₦$amount';
      color = Colors.amber;
    }

    return Positioned(
      top: 130,
      left: 30,
      right: 30,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 16),
        decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(12)),
        child: Text(message, textAlign: TextAlign.center, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 12)),
      ),
    );
  }
}
