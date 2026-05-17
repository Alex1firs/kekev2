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
import 'saved_locations_manager_screen.dart';

class HomeMapScreen extends ConsumerStatefulWidget {
  const HomeMapScreen({super.key});

  @override
  ConsumerState<HomeMapScreen> createState() => _HomeMapScreenState();
}

class _HomeMapScreenState extends ConsumerState<HomeMapScreen> {
  GoogleMapController? _mapController;
  BitmapDescriptor? _kekeMarkerIcon;
  BitmapDescriptor? _driverMarkerIcon;
  bool _hasFitToDriver = false;

  @override
  void initState() {
    super.initState();
    _loadKekeMarkers();
  }

  Future<void> _loadKekeMarkers() async {
    final results = await Future.wait([
      // Nearby idle drivers — yellow, smaller
      _drawKekeMarker(
        size: 58,
        bg: const Color(0xFFF59E0B),
        iconColor: const Color(0xFF111827),
        ringColor: Colors.white,
        ringWidth: 2.5,
      ),
      // Assigned driver — inverted (charcoal bg, yellow icon + ring) so yours stands out
      _drawKekeMarker(
        size: 72,
        bg: const Color(0xFF111827),
        iconColor: const Color(0xFFF59E0B),
        ringColor: const Color(0xFFF59E0B),
        ringWidth: 3.0,
      ),
    ]);
    if (mounted) {
      setState(() {
        _kekeMarkerIcon = results[0];
        _driverMarkerIcon = results[1];
      });
    }
  }

  Future<BitmapDescriptor> _drawKekeMarker({
    required double size,
    required Color bg,
    required Color iconColor,
    required Color ringColor,
    required double ringWidth,
  }) async {
    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder);
    final r = size / 2 - 4.0;
    final center = Offset(size / 2, size / 2);

    // Drop shadow
    canvas.drawCircle(
      center + const Offset(1, 2.5),
      r,
      Paint()
        ..color = const Color(0x55000000)
        ..maskFilter = const MaskFilter.blur(ui.BlurStyle.normal, 5),
    );
    // Background fill
    canvas.drawCircle(center, r, Paint()..color = bg);
    // Ring border
    canvas.drawCircle(
      center,
      r,
      Paint()
        ..color = ringColor
        ..style = PaintingStyle.stroke
        ..strokeWidth = ringWidth,
    );
    // Rickshaw icon via Material icon font glyph
    final tp = TextPainter(
      textDirection: TextDirection.ltr,
      text: TextSpan(
        text: String.fromCharCode(Icons.electric_rickshaw.codePoint),
        style: TextStyle(
          fontFamily: Icons.electric_rickshaw.fontFamily,
          fontSize: size * 0.44,
          color: iconColor,
        ),
      ),
    )..layout();
    tp.paint(canvas, center - Offset(tp.width / 2, tp.height / 2));

    final picture = recorder.endRecording();
    final img = await picture.toImage(size.toInt(), size.toInt());
    final bytes = await img.toByteData(format: ui.ImageByteFormat.png);
    return BitmapDescriptor.fromBytes(bytes!.buffer.asUint8List());
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(bookingControllerProvider);

    ref.listen(bookingControllerProvider.select((s) => s.step), (previous, next) {
      if (next == BookingStep.completed) {
        ref.read(walletControllerProvider.notifier).refresh();
      }
    });

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
      _mapController!.animateCamera(
          CameraUpdate.newLatLngBounds(LatLngBounds(southwest: sw, northeast: ne), 100));
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
          // ── Map / loading state
          if (state.step == BookingStep.loading)
            _buildMapLoading()
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
              onMapCreated: (c) => _mapController = c,
              onCameraMove: (p) =>
                  ref.read(bookingControllerProvider.notifier).onCameraMove(p),
              onCameraIdle: () =>
                  ref.read(bookingControllerProvider.notifier).onCameraIdle(),
              markers: _buildMarkers(state),
              polylines: _buildPolylines(state),
            ),

          // ── Quick-action menu (top-right)
          _buildActionArea(state),

          // ── Branded pickup / destination pin
          if (state.step == BookingStep.selectingPickup ||
              state.step == BookingStep.selectingDestinationOnMap)
            _PickupPin(
              label: state.step == BookingStep.selectingDestinationOnMap
                  ? 'Drop here'
                  : 'Pickup here',
              color: state.step == BookingStep.selectingDestinationOnMap
                  ? AppColors.error
                  : AppColors.primary,
              isMoving: state.isCameraMoving,
            ),

          // ── Booking sheet
          const BookingSheet(),
        ],
      ),
    );
  }

  Widget _buildMapLoading() {
    return Container(
      color: AppColors.charcoal,
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 72,
              height: 72,
              decoration: BoxDecoration(
                color: AppColors.primary,
                borderRadius: BorderRadius.circular(22),
                boxShadow: [
                  BoxShadow(
                    color: AppColors.primary.withOpacity(0.4),
                    blurRadius: 24,
                    offset: const Offset(0, 8),
                  ),
                ],
              ),
              child: const Icon(Icons.electric_rickshaw,
                  color: AppColors.charcoal, size: 40),
            ),
            const SizedBox(height: 24),
            const SizedBox(
              width: 20,
              height: 20,
              child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.primary),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildActionArea(BookingState state) {
    final hide = state.step == BookingStep.started ||
        state.step == BookingStep.arrived ||
        state.step == BookingStep.confirmed;
    if (hide) return const SizedBox.shrink();

    return Positioned(
      top: MediaQuery.of(context).padding.top + 12,
      right: 12,
      child: _QuickActionMenu(parentContext: context, ref: ref),
    );
  }

  Set<Marker> _buildMarkers(BookingState state) {
    final markers = <Marker>{};

    final showMarkersSteps = {
      BookingStep.previewEstimate,
      BookingStep.searching,
      BookingStep.confirmed,
      BookingStep.arrived,
      BookingStep.started,
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

    if (state.step == BookingStep.selectingPickup ||
        state.step == BookingStep.selectingDestination ||
        state.step == BookingStep.previewEstimate ||
        state.step == BookingStep.idle) {
      for (int i = 0; i < state.nearbyDrivers.length; i++) {
        markers.add(Marker(
          markerId: MarkerId('nearby_driver_$i'),
          position: state.nearbyDrivers[i],
          icon: _kekeMarkerIcon ??
              BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueOrange),
          zIndex: 1,
        ));
      }
    }

    if (state.assignedDriverLocation != null &&
        (state.step == BookingStep.confirmed ||
            state.step == BookingStep.arrived ||
            state.step == BookingStep.started)) {
      bool isStale = false;
      if (state.lastLocationUpdate != null) {
        if (DateTime.now().difference(state.lastLocationUpdate!).inSeconds > 30) {
          isStale = true;
        }
      }
      if (!isStale) {
        markers.add(Marker(
          markerId: const MarkerId('driver'),
          position: state.assignedDriverLocation!,
          icon: _driverMarkerIcon ??
              _kekeMarkerIcon ??
              BitmapDescriptor.defaultMarkerWithHue(BitmapDescriptor.hueOrange),
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
      BookingStep.started,
    };

    if (!showPolylineSteps.contains(state.step)) return {};

    final polylines = <Polyline>{};

    if (state.activeRoutePolyline.isNotEmpty) {
      final isDimmed = state.step == BookingStep.confirmed;
      polylines.add(Polyline(
        polylineId: const PolylineId('route'),
        // Deeper amber (primaryDark) gives better contrast on light map tiles
        color: isDimmed
            ? AppColors.primary.withOpacity(0.25)
            : AppColors.primaryDark,
        width: isDimmed ? 3 : 6,
        points: state.activeRoutePolyline,
        jointType: JointType.round,
        endCap: Cap.roundCap,
        startCap: Cap.roundCap,
      ));
    }

    if (state.step == BookingStep.confirmed &&
        state.assignedDriverLocation != null &&
        state.pickupLocation != null) {
      polylines.add(Polyline(
        polylineId: const PolylineId('driver_approach'),
        color: AppColors.primary,
        width: 3,
        points: [state.assignedDriverLocation!, state.pickupLocation!],
        jointType: JointType.round,
        endCap: Cap.roundCap,
        startCap: Cap.roundCap,
        patterns: [PatternItem.dash(20), PatternItem.gap(10)],
      ));
    }

    return polylines;
  }
}

// ── Quick-action expandable menu ───────────────────────────────────────────

class _ActionItem {
  final IconData icon;
  final String label;
  const _ActionItem(this.icon, this.label);
}

class _QuickActionMenu extends StatefulWidget {
  final BuildContext parentContext;
  final WidgetRef ref;
  const _QuickActionMenu({required this.parentContext, required this.ref});

  @override
  State<_QuickActionMenu> createState() => _QuickActionMenuState();
}

class _QuickActionMenuState extends State<_QuickActionMenu>
    with SingleTickerProviderStateMixin {
  bool _isOpen = false;
  late AnimationController _ctrl;

  static const _items = [
    _ActionItem(Icons.person_outline, 'Profile'),
    _ActionItem(Icons.history_rounded, 'My Trips'),
    _ActionItem(Icons.star_border_rounded, 'Saved'),
    _ActionItem(Icons.account_balance_wallet_outlined, 'Wallet'),
  ];

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
        vsync: this, duration: const Duration(milliseconds: 260));
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  void _toggle() {
    setState(() => _isOpen = !_isOpen);
    _isOpen ? _ctrl.forward() : _ctrl.reverse();
  }

  void _navigate(int index) {
    _toggle();
    Widget screen;
    switch (index) {
      case 0:
        screen = const PassengerProfileScreen();
        break;
      case 1:
        screen = const PassengerTripHistoryScreen();
        break;
      case 2:
        screen = const SavedLocationsManagerScreen();
        break;
      case 3:
        screen = const WalletScreen();
        break;
      default:
        return;
    }
    Navigator.push(
        widget.parentContext, MaterialPageRoute(builder: (_) => screen));
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        // Toggle FAB
        GestureDetector(
          onTap: _toggle,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 220),
            width: 46,
            height: 46,
            decoration: BoxDecoration(
              color: _isOpen ? AppColors.charcoal : AppColors.primary,
              borderRadius: BorderRadius.circular(14),
              boxShadow: [
                BoxShadow(
                  color: (_isOpen ? AppColors.charcoal : AppColors.primary)
                      .withOpacity(0.35),
                  blurRadius: 14,
                  offset: const Offset(0, 4),
                ),
              ],
            ),
            child: AnimatedRotation(
              turns: _isOpen ? 0.125 : 0.0,
              duration: const Duration(milliseconds: 260),
              child: Icon(
                _isOpen ? Icons.close_rounded : Icons.menu_rounded,
                size: 22,
                color: _isOpen ? AppColors.white : AppColors.charcoal,
              ),
            ),
          ),
        ),
        const SizedBox(height: 8),

        // Action items
        for (int i = 0; i < _items.length; i++) ...[
          _AnimatedMenuItem(
            ctrl: _ctrl,
            delay: i * 0.07,
            icon: _items[i].icon,
            label: _items[i].label,
            onTap: () => _navigate(i),
          ),
          const SizedBox(height: 6),
        ],

        // Logout (danger tone)
        _AnimatedMenuItem(
          ctrl: _ctrl,
          delay: _items.length * 0.07,
          icon: Icons.logout_rounded,
          label: 'Logout',
          iconColor: AppColors.error,
          onTap: () {
            _toggle();
            widget.ref.read(authControllerProvider.notifier).logout();
          },
        ),
      ],
    );
  }
}

class _AnimatedMenuItem extends StatelessWidget {
  final AnimationController ctrl;
  final double delay;
  final IconData icon;
  final String label;
  final Color? iconColor;
  final VoidCallback onTap;

  const _AnimatedMenuItem({
    required this.ctrl,
    required this.delay,
    required this.icon,
    required this.label,
    required this.onTap,
    this.iconColor,
  });

  @override
  Widget build(BuildContext context) {
    final anim = CurvedAnimation(
      parent: ctrl,
      curve: Interval(delay.clamp(0.0, 0.85), 1.0, curve: Curves.easeOutCubic),
    );
    return FadeTransition(
      opacity: anim,
      child: SlideTransition(
        position: Tween<Offset>(
          begin: const Offset(0.5, 0),
          end: Offset.zero,
        ).animate(anim),
        child: GestureDetector(
          onTap: onTap,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
            decoration: BoxDecoration(
              color: AppColors.white,
              borderRadius: BorderRadius.circular(12),
              boxShadow: const [
                BoxShadow(
                    color: Color(0x20000000), blurRadius: 8, offset: Offset(0, 2)),
              ],
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(icon, size: 17, color: iconColor ?? AppColors.charcoal),
                const SizedBox(width: 7),
                Text(
                  label,
                  style: AppTextStyles.label(
                    color: iconColor ?? AppColors.charcoal,
                    weight: FontWeight.w700,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

// ── Branded pickup pin ─────────────────────────────────────────────────────

class _PickupPin extends StatefulWidget {
  final String label;
  final Color color;
  final bool isMoving;
  const _PickupPin(
      {required this.label, required this.color, required this.isMoving});

  @override
  State<_PickupPin> createState() => _PickupPinState();
}

class _PickupPinState extends State<_PickupPin>
    with SingleTickerProviderStateMixin {
  late AnimationController _ctrl;
  late Animation<double> _scale;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
        vsync: this, duration: const Duration(milliseconds: 700));
    _scale = Tween<double>(begin: 0.7, end: 1.0).animate(
      CurvedAnimation(parent: _ctrl, curve: Curves.elasticOut),
    );
    _ctrl.forward();
  }

  @override
  void didUpdateWidget(_PickupPin old) {
    super.didUpdateWidget(old);
    if (!widget.isMoving && old.isMoving) {
      _ctrl.forward(from: 0.0);
    }
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final labelColor =
        widget.isMoving ? widget.color.withOpacity(0.75) : widget.color;

    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ScaleTransition(
            scale: _scale,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                // Label bubble
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                  decoration: BoxDecoration(
                    color: labelColor,
                    borderRadius: BorderRadius.circular(10),
                    boxShadow: [
                      BoxShadow(
                        color: widget.color.withOpacity(0.3),
                        blurRadius: 12,
                        offset: const Offset(0, 4),
                      ),
                    ],
                  ),
                  child: Text(
                    widget.isMoving ? 'Moving…' : widget.label,
                    style: AppTextStyles.label(
                      color: AppColors.charcoal,
                      weight: FontWeight.w800,
                    ),
                  ),
                ),
                // Triangle caret
                CustomPaint(
                  size: const Size(16, 8),
                  painter: _TrianglePainter(color: labelColor),
                ),
                // Stem
                Container(width: 2.5, height: 20, color: widget.color),
                // Dot
                Container(
                  width: 10,
                  height: 10,
                  decoration: BoxDecoration(
                    color: widget.color,
                    shape: BoxShape.circle,
                    boxShadow: [
                      BoxShadow(
                        color: widget.color.withOpacity(0.5),
                        blurRadius: 8,
                        spreadRadius: 2,
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 56),
        ],
      ),
    );
  }
}

class _TrianglePainter extends CustomPainter {
  final Color color;
  const _TrianglePainter({required this.color});

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawPath(
      Path()
        ..moveTo(0, 0)
        ..lineTo(size.width, 0)
        ..lineTo(size.width / 2, size.height)
        ..close(),
      Paint()..color = color,
    );
  }

  @override
  bool shouldRepaint(_TrianglePainter old) => old.color != color;
}
