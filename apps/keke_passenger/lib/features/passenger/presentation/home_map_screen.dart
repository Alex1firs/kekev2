import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import '../../../core/theme/app_theme.dart';
import '../../auth/application/auth_controller.dart';
import '../application/booking_controller.dart';
import '../application/wallet_controller.dart';
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
  BitmapDescriptor? _kekeMarkerIcon;
  bool _hasFitToDriver = false;

  @override
  void initState() {
    super.initState();
    _loadKekeMarker();
  }

  Future<void> _loadKekeMarker() async {
    const double size = 56;
    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder);

    // Drop shadow
    canvas.drawCircle(
      const Offset(size / 2 + 1, size / 2 + 2),
      size / 2 - 3,
      Paint()
        ..color = const Color(0x50000000)
        ..maskFilter = const MaskFilter.blur(ui.BlurStyle.normal, 4),
    );

    // Amber fill
    canvas.drawCircle(
      const Offset(size / 2, size / 2),
      size / 2 - 3,
      Paint()..color = const Color(0xFFF59E0B),
    );

    // White border
    canvas.drawCircle(
      const Offset(size / 2, size / 2),
      size / 2 - 3,
      Paint()
        ..color = Colors.white
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2.5,
    );

    // White "K" for Keke
    final tp = TextPainter(
      text: const TextSpan(
        text: 'K',
        style: TextStyle(
          color: Colors.white,
          fontSize: 26,
          fontWeight: FontWeight.w900,
        ),
      ),
      textDirection: TextDirection.ltr,
    )..layout();
    tp.paint(canvas, Offset((size - tp.width) / 2, (size - tp.height) / 2));

    final picture = recorder.endRecording();
    final img = await picture.toImage(size.toInt(), size.toInt());
    final bytes = await img.toByteData(format: ui.ImageByteFormat.png);
    if (mounted && bytes != null) {
      setState(() {
        _kekeMarkerIcon = BitmapDescriptor.fromBytes(bytes.buffer.asUint8List());
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(bookingControllerProvider);

    ref.listen(bookingControllerProvider.select((s) => s.step), (previous, next) {
      if (next == BookingStep.completed) {
        ref.read(walletControllerProvider.notifier).refresh();
      }
    });

    // Auto-fit camera when driver first appears during confirmed state
    ref.listen(bookingControllerProvider.select((s) => s.assignedDriverLocation), (prev, next) {
      if (next == null || _mapController == null) return;
      final step = ref.read(bookingControllerProvider).step;
      if (step != BookingStep.confirmed) return;
      if (_hasFitToDriver) return;
      final pickup = ref.read(bookingControllerProvider).pickupLocation;
      if (pickup == null) return;
      _hasFitToDriver = true;
      final sw = LatLng(
        next.latitude < pickup.latitude ? next.latitude : pickup.latitude,
        next.longitude < pickup.longitude ? next.longitude : pickup.longitude,
      );
      final ne = LatLng(
        next.latitude > pickup.latitude ? next.latitude : pickup.latitude,
        next.longitude > pickup.longitude ? next.longitude : pickup.longitude,
      );
      _mapController!.animateCamera(CameraUpdate.newLatLngBounds(LatLngBounds(southwest: sw, northeast: ne), 100));
    });

    ref.listen(bookingControllerProvider.select((s) => s.step), (prev, next) {
      if (next != BookingStep.confirmed) _hasFitToDriver = false;
    });

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

    // Display nearby drivers before an active ride
    if (state.step == BookingStep.selectingPickup || 
        state.step == BookingStep.selectingDestination || 
        state.step == BookingStep.previewEstimate || 
        state.step == BookingStep.idle) {
      
      for (int i = 0; i < state.nearbyDrivers.length; i++) {
        markers.add(Marker(
          markerId: MarkerId('nearby_driver_$i'),
          position: state.nearbyDrivers[i],
          icon: _kekeMarkerIcon ?? BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueOrange),
          zIndex: 1, // Draw under the main active driver if any
        ));
      }
    }

    // Display the assigned active driver
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
          icon: _kekeMarkerIcon ?? BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueOrange),
          infoWindow: const InfoWindow(title: 'Your Keke'),
          zIndex: 2,
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

    if (!showPolylineSteps.contains(state.step)) return {};

    final polylines = <Polyline>{};

    if (state.activeRoutePolyline.isNotEmpty) {
      // Main route: slightly dimmed during confirmed (driver approach) so approach line stands out
      final isDimmed = state.step == BookingStep.confirmed;
      polylines.add(Polyline(
        polylineId: const PolylineId('route'),
        color: isDimmed ? AppColors.primary.withOpacity(0.35) : AppColors.primary,
        width: isDimmed ? 3 : 5,
        points: state.activeRoutePolyline,
        jointType: JointType.round,
        endCap: Cap.roundCap,
        startCap: Cap.roundCap,
      ));
    }

    // Driver-to-pickup approach line — shown while driver is heading to passenger
    if (state.step == BookingStep.confirmed &&
        state.assignedDriverLocation != null &&
        state.pickupLocation != null) {
      polylines.add(Polyline(
        polylineId: const PolylineId('driver_approach'),
        color: const Color(0xFFF59E0B), // amber
        width: 4,
        points: [state.assignedDriverLocation!, state.pickupLocation!],
        jointType: JointType.round,
        endCap: Cap.roundCap,
        startCap: Cap.roundCap,
        patterns: [PatternItem.dash(16), PatternItem.gap(8)],
      ));
    }

    return polylines;
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
