import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import '../../auth/application/auth_controller.dart';
import '../application/booking_controller.dart';
import '../domain/booking_state.dart';
import 'widgets/booking_sheet.dart';

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

    // Camera fitting logic for Route Preview
    ref.listen(bookingControllerProvider, (previous, next) {
      if (next.step == BookingStep.previewEstimate && _mapController != null) {
        if (next.pickupLocation != null && next.destinationLocation != null) {
          final bounds = LatLngBounds(
            southwest: LatLng(
              next.pickupLocation!.latitude < next.destinationLocation!.latitude ? next.pickupLocation!.latitude : next.destinationLocation!.latitude,
              next.pickupLocation!.longitude < next.destinationLocation!.longitude ? next.pickupLocation!.longitude : next.destinationLocation!.longitude,
            ),
            northeast: LatLng(
              next.pickupLocation!.latitude > next.destinationLocation!.latitude ? next.pickupLocation!.latitude : next.destinationLocation!.latitude,
              next.pickupLocation!.longitude > next.destinationLocation!.longitude ? next.pickupLocation!.longitude : next.destinationLocation!.longitude,
            ),
          );
          _mapController!.animateCamera(CameraUpdate.newLatLngBounds(bounds, 80));
        }
      }
    });

    return Scaffold(
      extendBodyBehindAppBar: true,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        actions: [
          IconButton(
            icon: const Icon(Icons.logout, color: Colors.black87),
            onPressed: () {
              ref.read(authControllerProvider.notifier).logout();
            },
            tooltip: 'Logout',
          )
        ],
      ),
      body: Stack(
        children: [
          if (state.step == BookingStep.loading)
            const Center(child: CircularProgressIndicator())
          else
            GoogleMap(
              initialCameraPosition: CameraPosition(
                target: state.mapCenter ?? const LatLng(6.1264, 6.7876),
                zoom: 15,
              ),
              myLocationEnabled: true,
              myLocationButtonEnabled: false,
              zoomControlsEnabled: false,
              onMapCreated: (controller) {
                print("DEBUG: Google Map successfully created!");
                _mapController = controller;
              },
              onCameraMove: (position) {
                ref.read(bookingControllerProvider.notifier).onCameraMove(position);
              },
              onCameraIdle: () {
                print("DEBUG: Map Camera is Idle at: ${state.mapCenter}");
                ref.read(bookingControllerProvider.notifier).onCameraIdle();
              },
              markers: _buildMarkers(state),
              polylines: _buildPolylines(state),
            ),
            
          // Fixed center pin UI, visibly blocked if we are past pickup selection
          if (state.step == BookingStep.selectingPickup)
            const Center(
              child: Padding(
                padding: EdgeInsets.only(bottom: 35.0), // Align bottom tip to map center
                child: Icon(Icons.location_on, size: 50, color: Colors.amber),
              ),
            ),
          
          // Booking Bottom Sheet
          const BookingSheet(),
        ],
      ),
    );
  }

  Set<Marker> _buildMarkers(BookingState state) {
    if (state.step != BookingStep.previewEstimate) return {};
    
    // When generating preview, we replace the fixed pin with explicit markers
    final markers = <Marker>{};
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
    return markers;
  }

  Set<Polyline> _buildPolylines(BookingState state) {
    if (state.step != BookingStep.previewEstimate || state.activeRoutePolyline.isEmpty) {
      return {};
    }
    
    return {
      Polyline(
        polylineId: const PolylineId('route'),
        color: Colors.blueAccent,
        width: 5,
        points: state.activeRoutePolyline,
      )
    };
  }
}
