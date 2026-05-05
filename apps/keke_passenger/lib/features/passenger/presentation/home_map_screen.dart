import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import '../../../core/theme/app_theme.dart';
import '../../auth/application/auth_controller.dart';
import '../application/booking_controller.dart';
import '../domain/booking_state.dart';
import 'widgets/booking_sheet.dart';
import 'wallet_screen.dart';
import 'trip_history_screen.dart';
import 'profile_screen.dart';

class HomeMapScreen extends ConsumerStatefulWidget {
  const HomeMapScreen({super.key});

  @override
  ConsumerState<HomeMapScreen> createState() => _HomeMapScreenState();
}

class _HomeMapScreenState extends ConsumerState<HomeMapScreen> {
  GoogleMapController? _mapController;

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(bookingControllerProvider);

    ref.listen(bookingControllerProvider, (previous, next) {
      if (next.step == BookingStep.previewEstimate && _mapController != null) {
        if (next.pickupLocation != null && next.destinationLocation != null) {
          final bounds = LatLngBounds(
            southwest: LatLng(
              next.pickupLocation!.latitude < next.destinationLocation!.latitude
                  ? next.pickupLocation!.latitude
                  : next.destinationLocation!.latitude,
              next.pickupLocation!.longitude < next.destinationLocation!.longitude
                  ? next.pickupLocation!.longitude
                  : next.destinationLocation!.longitude,
            ),
            northeast: LatLng(
              next.pickupLocation!.latitude > next.destinationLocation!.latitude
                  ? next.pickupLocation!.latitude
                  : next.destinationLocation!.latitude,
              next.pickupLocation!.longitude > next.destinationLocation!.longitude
                  ? next.pickupLocation!.longitude
                  : next.destinationLocation!.longitude,
            ),
          );
          _mapController!.animateCamera(CameraUpdate.newLatLngBounds(bounds, 80));
        }
      }
    });

    return Scaffold(
      extendBodyBehindAppBar: true,
      body: Stack(
        children: [
          // Map
          if (state.step == BookingStep.loading)
            Container(
              color: AppColors.paleGray,
              child: const Center(child: CircularProgressIndicator()),
            )
          else
            GoogleMap(
              initialCameraPosition: CameraPosition(
                target: state.mapCenter ?? const LatLng(6.1264, 6.7876),
                zoom: 15,
              ),
              myLocationEnabled: true,
              myLocationButtonEnabled: false,
              zoomControlsEnabled: false,
              compassEnabled: false,
              onMapCreated: (controller) => _mapController = controller,
              onCameraMove: (position) =>
                  ref.read(bookingControllerProvider.notifier).onCameraMove(position),
              onCameraIdle: () =>
                  ref.read(bookingControllerProvider.notifier).onCameraIdle(),
              markers: _buildMarkers(state),
              polylines: _buildPolylines(state),
            ),

          // Top action bar — overlays the map
          _buildTopBar(state),

          // Fixed pickup pin for camera-based pickup selection
          if (state.step == BookingStep.selectingPickup)
            const _PickupPin(),

          // Booking bottom sheet
          const BookingSheet(),
        ],
      ),
    );
  }

  Widget _buildTopBar(BookingState state) {
    // Hide top bar when actively in a ride (HUD is the only interface)
    final hideBar = state.step == BookingStep.started ||
        state.step == BookingStep.arrived ||
        state.step == BookingStep.confirmed;

    if (hideBar) return const SizedBox.shrink();

    return Positioned(
      top: MediaQuery.of(context).padding.top + 12,
      right: 12,
      child: Column(
        children: [
          _MapIconButton(
            icon: Icons.person_outline,
            tooltip: 'Profile',
            onTap: () => Navigator.push(
              context, MaterialPageRoute(builder: (_) => const PassengerProfileScreen())),
          ),
          const SizedBox(height: 8),
          _MapIconButton(
            icon: Icons.history_rounded,
            tooltip: 'Trip History',
            onTap: () => Navigator.push(
              context, MaterialPageRoute(builder: (_) => const PassengerTripHistoryScreen())),
          ),
          const SizedBox(height: 8),
          _MapIconButton(
            icon: Icons.account_balance_wallet_outlined,
            tooltip: 'Wallet',
            onTap: () => Navigator.push(
              context, MaterialPageRoute(builder: (_) => const WalletScreen())),
          ),
          const SizedBox(height: 8),
          _MapIconButton(
            icon: Icons.logout_rounded,
            tooltip: 'Logout',
            onTap: () => ref.read(authControllerProvider.notifier).logout(),
          ),
        ],
      ),
    );
  }

  Set<Marker> _buildMarkers(BookingState state) {
    final markers = <Marker>{};

    final showMarkersSteps = {
      BookingStep.previewEstimate,
      BookingStep.searching,
      BookingStep.confirmed,
      BookingStep.arrived,
      BookingStep.started
    };

    if (showMarkersSteps.contains(state.step)) {
      if (state.pickupLocation != null) {
        markers.add(Marker(
          markerId: const MarkerId('pickup'),
          position: state.pickupLocation!,
          icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueYellow),
        ));
      }
      if (state.destinationLocation != null) {
        markers.add(Marker(
          markerId: const MarkerId('destination'),
          position: state.destinationLocation!,
          icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueRed),
        ));
      }
    }

    if (state.assignedDriverLocation != null &&
        (state.step == BookingStep.confirmed ||
            state.step == BookingStep.arrived ||
            state.step == BookingStep.started)) {
      bool isStale = false;
      if (state.lastLocationUpdate != null) {
        final diff = DateTime.now().difference(state.lastLocationUpdate!);
        if (diff.inSeconds > 30) isStale = true;
      }
      if (!isStale) {
        markers.add(Marker(
          markerId: const MarkerId('driver'),
          position: state.assignedDriverLocation!,
          icon: BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueAzure),
          infoWindow: const InfoWindow(title: 'Your Keke'),
        ));
      }
    }

    return markers;
  }

  Set<Polyline> _buildPolylines(BookingState state) {
    final showPolylineSteps = {
      BookingStep.previewEstimate,
      BookingStep.searching,
      BookingStep.confirmed,
      BookingStep.arrived,
      BookingStep.started
    };

    if (!showPolylineSteps.contains(state.step) || state.activeRoutePolyline.isEmpty) {
      return {};
    }

    return {
      Polyline(
        polylineId: const PolylineId('route'),
        color: AppColors.primary,
        width: 5,
        points: state.activeRoutePolyline,
        jointType: JointType.round,
        endCap: Cap.roundCap,
        startCap: Cap.roundCap,
      )
    };
  }
}

class _PickupPin extends StatelessWidget {
  const _PickupPin();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            decoration: BoxDecoration(
              color: AppColors.charcoal,
              borderRadius: BorderRadius.circular(8),
            ),
            child: const Text('Pickup here', style: TextStyle(color: AppColors.white, fontSize: 12, fontWeight: FontWeight.w600)),
          ),
          const SizedBox(height: 4),
          const Icon(Icons.location_on, size: 44, color: AppColors.primary),
          const SizedBox(height: 44),
        ],
      ),
    );
  }
}

class _MapIconButton extends StatelessWidget {
  final IconData icon;
  final String tooltip;
  final VoidCallback onTap;

  const _MapIconButton({required this.icon, required this.tooltip, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tooltip,
      child: GestureDetector(
        onTap: onTap,
        child: Container(
          width: 40,
          height: 40,
          decoration: BoxDecoration(
            color: AppColors.white,
            borderRadius: BorderRadius.circular(12),
            boxShadow: const [BoxShadow(color: Color(0x18000000), blurRadius: 8, offset: Offset(0, 2))],
          ),
          child: Icon(icon, size: 20, color: AppColors.charcoal),
        ),
      ),
    );
  }
}
