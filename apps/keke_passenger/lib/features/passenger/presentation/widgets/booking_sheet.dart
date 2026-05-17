import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../../../core/theme/app_theme.dart';
import '../../domain/booking_state.dart';
import '../../application/booking_controller.dart';
import '../../application/wallet_controller.dart';
import '../destination_search_screen.dart';
import '../wallet_screen.dart';
import 'ride_chat_panel.dart';
import 'ride_receipt_sheet.dart';
import 'dart:math' as math;

class BookingSheet extends ConsumerWidget {
  const BookingSheet({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(bookingControllerProvider);

    return Align(
      alignment: Alignment.bottomCenter,
      child: Container(
        decoration: const BoxDecoration(
          color: AppColors.white,
          borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
          boxShadow: [
            BoxShadow(color: Color(0x22000000), blurRadius: 28, offset: Offset(0, -6)),
          ],
        ),
        child: SafeArea(
          top: false,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const _SheetHandle(),
              ConstrainedBox(
                constraints: BoxConstraints(
                  maxHeight: MediaQuery.of(context).size.height * 0.75,
                ),
                child: SingleChildScrollView(
                  physics: const BouncingScrollPhysics(),
                  padding: const EdgeInsets.fromLTRB(20, 4, 20, 20),
                  child: AnimatedSwitcher(
                    duration: const Duration(milliseconds: 300),
                    switchInCurve: Curves.easeOutCubic,
                    switchOutCurve: Curves.easeInCubic,
                    transitionBuilder: (child, animation) => FadeTransition(
                      opacity: animation,
                      child: SlideTransition(
                        position: Tween<Offset>(
                                begin: const Offset(0, 0.07), end: Offset.zero)
                            .animate(animation),
                        child: child,
                      ),
                    ),
                    child: KeyedSubtree(
                      key: ValueKey(BookingSheet._panelKey(state.step)),
                      child: _buildPanel(context, ref, state),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildPanel(BuildContext context, WidgetRef ref, BookingState state) {
    switch (state.step) {
      case BookingStep.loading:
      case BookingStep.idle:
        return const SizedBox(
          height: 120,
          child: Center(
              child: CircularProgressIndicator(color: AppColors.primary)),
        );
      case BookingStep.selectingPickup:
        return _buildPickupPanel(context, ref, state);
      case BookingStep.selectingDestination:
        return _buildDestinationPanel(context, ref, state);
      case BookingStep.selectingDestinationOnMap:
        return _buildDestinationMapPanel(context, ref, state);
      case BookingStep.previewEstimate:
        return _buildFarePanel(context, ref, state);
      case BookingStep.searching:
        return _buildSearchingPanel(context, ref, state);
      case BookingStep.confirmed:
      case BookingStep.arrived:
      case BookingStep.started:
        return _buildRideActivePanel(context, ref, state);
      case BookingStep.completed:
        return const RideReceiptSheet();
    }
  }

  // ── Pickup selection ───────────────────────────────────────────────────

  Widget _buildPickupPanel(
      BuildContext context, WidgetRef ref, BookingState state) {
    final isMoving = state.isCameraMoving;
    final address = state.pickupAddress ?? 'Locating…';

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Header
        Row(
          children: [
            Container(
              width: 36,
              height: 36,
              decoration: BoxDecoration(
                color: AppColors.primary,
                borderRadius: BorderRadius.circular(10),
              ),
              child: const Icon(Icons.my_location_rounded,
                  color: AppColors.charcoal, size: 18),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Confirm Pickup', style: AppTextStyles.title()),
                  Text(
                    'Choose where your Keke should meet you',
                    style: AppTextStyles.caption(color: AppColors.midGray),
                  ),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 18),

        // Location card
        GestureDetector(
          onTap: isMoving
              ? null
              : () async {
                  final result =
                      await Navigator.push<Map<String, dynamic>>(
                    context,
                    MaterialPageRoute(
                        builder: (_) => const DestinationSearchScreen(
                            hintText: 'Enter Pickup Location')),
                  );
                  if (result != null) {
                    ref
                        .read(bookingControllerProvider.notifier)
                        .setPickup(result['address'] as String,
                            result['location'] as LatLng);
                  }
                },
          child: Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: AppColors.paleGray,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: AppColors.border),
            ),
            child: Row(
              children: [
                Container(
                  width: 4,
                  height: 36,
                  decoration: BoxDecoration(
                    color: AppColors.primary,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Pickup location',
                          style:
                              AppTextStyles.caption(color: AppColors.midGray)),
                      const SizedBox(height: 2),
                      Text(
                        isMoving ? 'Moving map…' : address,
                        style: AppTextStyles.body(color: AppColors.charcoal),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                  ),
                ),
                if (!isMoving)
                  const Icon(Icons.edit_location_alt_outlined,
                      size: 18, color: AppColors.lightGray),
              ],
            ),
          ),
        ),

        const SizedBox(height: 8),
        Text(
          'Move the map to adjust your pickup point',
          style: AppTextStyles.caption(color: AppColors.lightGray),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 16),

        // ETA banner
        if (!isMoving &&
            state.nearbyDrivers.isNotEmpty &&
            state.pickupLocation != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: _NearbyEtaBanner(
              pickup: state.pickupLocation!,
              drivers: state.nearbyDrivers,
            ),
          ),

        // CTA
        _PrimaryButton(
          label: 'Confirm Pickup',
          icon: Icons.check_rounded,
          enabled: !isMoving && state.pickupLocation != null,
          onTap: () =>
              ref.read(bookingControllerProvider.notifier).confirmPickup(),
        ),
      ],
    );
  }

  // ── Destination selection ──────────────────────────────────────────────

  Widget _buildDestinationPanel(
      BuildContext context, WidgetRef ref, BookingState state) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            GestureDetector(
              onTap: () =>
                  ref.read(bookingControllerProvider.notifier).retreatToPickup(),
              child: Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                  color: AppColors.paleGray,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: AppColors.border),
                ),
                child: const Icon(Icons.arrow_back_rounded,
                    size: 18, color: AppColors.charcoal),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Where to?', style: AppTextStyles.title()),
                  Text('Set your destination',
                      style: AppTextStyles.caption(color: AppColors.midGray)),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 16),

        // Pickup row (read-only reference)
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(
            color: AppColors.surfaceVariant,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: AppColors.border),
          ),
          child: Row(
            children: [
              Container(
                width: 8,
                height: 8,
                decoration: const BoxDecoration(
                    color: AppColors.primary, shape: BoxShape.circle),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  state.pickupAddress ?? 'Pickup',
                  style: AppTextStyles.bodySmall(color: AppColors.midGray),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 4),

        // Vertical connector
        Padding(
          padding: const EdgeInsets.only(left: 17),
          child: Container(width: 2, height: 14, color: AppColors.border),
        ),
        const SizedBox(height: 4),

        // Destination search tap target
        GestureDetector(
          onTap: () async {
            final result = await Navigator.push<Map<String, dynamic>>(
              context,
              MaterialPageRoute(
                  builder: (_) => const DestinationSearchScreen()),
            );
            if (result != null) {
              if (result['manual_selection'] == true) {
                ref
                    .read(bookingControllerProvider.notifier)
                    .startDestinationMapSelection();
              } else {
                ref.read(bookingControllerProvider.notifier).setDestination(
                    result['address'] as String,
                    result['location'] as LatLng);
              }
            }
          },
          child: Container(
            padding:
                const EdgeInsets.symmetric(horizontal: 14, vertical: 15),
            decoration: BoxDecoration(
              color: AppColors.paleGray,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppColors.border),
            ),
            child: Row(
              children: [
                const Icon(Icons.search_rounded,
                    color: AppColors.midGray, size: 20),
                const SizedBox(width: 10),
                Text('Search destination…',
                    style: AppTextStyles.body(color: AppColors.lightGray)),
              ],
            ),
          ),
        ),
        const SizedBox(height: 8),
      ],
    );
  }

  // ── Destination on-map selection ───────────────────────────────────────

  Widget _buildDestinationMapPanel(
      BuildContext context, WidgetRef ref, BookingState state) {
    final isMoving = state.isCameraMoving;
    final address = state.destinationAddress ?? 'Locating…';

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            GestureDetector(
              onTap: () =>
                  ref.read(bookingControllerProvider.notifier).confirmPickup(),
              child: Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                  color: AppColors.paleGray,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: AppColors.border),
                ),
                child: const Icon(Icons.arrow_back_rounded,
                    size: 18, color: AppColors.charcoal),
              ),
            ),
            const SizedBox(width: 12),
            Text('Set Destination', style: AppTextStyles.title()),
          ],
        ),
        const SizedBox(height: 14),
        _AddressRow(
          icon: Icons.location_on_rounded,
          iconColor: AppColors.error,
          text: isMoving ? 'Moving map…' : address,
        ),
        const SizedBox(height: 16),
        _PrimaryButton(
          label: 'Confirm Destination',
          icon: Icons.check_rounded,
          enabled: !isMoving && state.destinationLocation != null,
          onTap: () => ref
              .read(bookingControllerProvider.notifier)
              .confirmDestinationOnMap(),
        ),
      ],
    );
  }

  // ── Fare estimate ──────────────────────────────────────────────────────

  Widget _buildFarePanel(
      BuildContext context, WidgetRef ref, BookingState state) {
    if (state.errorMessage != null && state.estimatedFareAmount == null) {
      return _ErrorState(
        message: state.errorMessage!,
        onRetry: () =>
            ref.read(bookingControllerProvider.notifier).retreatToPickup(),
      );
    }
    if (state.estimatedFareAmount == null) {
      return const SizedBox(
        height: 180,
        child: Center(
            child: CircularProgressIndicator(color: AppColors.primary)),
      );
    }

    final walletState = ref.watch(walletControllerProvider);

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            GestureDetector(
              onTap: () =>
                  ref.read(bookingControllerProvider.notifier).retreatToPickup(),
              child: Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                  color: AppColors.paleGray,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: AppColors.border),
                ),
                child: const Icon(Icons.arrow_back_rounded,
                    size: 18, color: AppColors.charcoal),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Your Ride', style: AppTextStyles.title()),
                  Text('Review fare and payment',
                      style: AppTextStyles.caption(color: AppColors.midGray)),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 16),

        // ETA banner
        if (state.nearbyDrivers.isNotEmpty && state.pickupLocation != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 14),
            child: _NearbyEtaBanner(
              pickup: state.pickupLocation!,
              drivers: state.nearbyDrivers,
            ),
          ),

        // Fare card
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: AppColors.charcoal,
            borderRadius: BorderRadius.circular(18),
            boxShadow: const [
              BoxShadow(
                  color: Color(0x20000000), blurRadius: 16, offset: Offset(0, 4)),
            ],
          ),
          child: Row(
            children: [
              Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                  color: AppColors.primary,
                  borderRadius: BorderRadius.circular(14),
                ),
                child: const Icon(Icons.electric_rickshaw,
                    size: 28, color: AppColors.charcoal),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Keke Napep',
                        style: AppTextStyles.body(
                            color: AppColors.white, weight: FontWeight.w700)),
                    Text(
                      '${state.estimatedTime ?? '—'} · ${state.estimatedDistance ?? '—'}',
                      style: AppTextStyles.bodySmall(color: AppColors.lightGray),
                    ),
                  ],
                ),
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Text('Fare',
                      style: AppTextStyles.caption(color: AppColors.midGray)),
                  Text(
                    '₦${NumberFormat('#,###').format(state.estimatedFareAmount)}',
                    style: AppTextStyles.headline(color: AppColors.primary),
                  ),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 18),

        Text('Pay with',
            style:
                AppTextStyles.label(color: AppColors.midGray, weight: FontWeight.w700)),
        const SizedBox(height: 8),
        _PaymentSelector(
          selected: state.paymentMethod,
          walletBalance: walletState.balance,
          fare: state.estimatedFareAmount ?? 0,
          onSelect: (m) =>
              ref.read(bookingControllerProvider.notifier).setPaymentMethod(m),
          onTopUp: () => Navigator.push(
              context, MaterialPageRoute(builder: (_) => const WalletScreen())),
        ),
        const SizedBox(height: 16),

        if (state.errorMessage != null) ...[
          _InlineError(message: state.errorMessage!),
          const SizedBox(height: 12),
        ],

        _PrimaryButton(
          label: 'Request Keke',
          icon: Icons.electric_rickshaw,
          onTap: () =>
              ref.read(bookingControllerProvider.notifier).requestRide(),
        ),
      ],
    );
  }

  // ── Searching ──────────────────────────────────────────────────────────

  Widget _buildSearchingPanel(
      BuildContext context, WidgetRef ref, BookingState state) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (state.errorMessage != null) ...[
          const SizedBox(height: 4),
          _InlineError(message: state.errorMessage!),
          const SizedBox(height: 12),
        ],

        const SizedBox(height: 8),
        const _KekeSearchAnimation(),
        const SizedBox(height: 20),

        Text('Finding your Keke…', style: AppTextStyles.title()),
        const SizedBox(height: 6),
        Text(
          'Connecting to nearby Keke drivers in Awka',
          style: AppTextStyles.bodySmall(color: AppColors.midGray),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 28),

        OutlinedButton(
          style: OutlinedButton.styleFrom(
            foregroundColor: AppColors.error,
            side: const BorderSide(color: AppColors.error),
            minimumSize: const Size(double.infinity, 50),
            shape:
                RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
          ),
          onPressed: () =>
              ref.read(bookingControllerProvider.notifier).cancelBooking(),
          child: const Text('Cancel Request'),
        ),
        const SizedBox(height: 4),
      ],
    );
  }

  // ── Active ride ────────────────────────────────────────────────────────

  Widget _buildRideActivePanel(
      BuildContext context, WidgetRef ref, BookingState state) {
    final driver = state.assignedDriver;
    if (driver == null) {
      return Container(
        height: 120,
        decoration: BoxDecoration(
          color: AppColors.surfaceVariant,
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: AppColors.border),
        ),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const SizedBox(
              width: 22,
              height: 22,
              child: CircularProgressIndicator(
                  strokeWidth: 2.5, color: AppColors.primary),
            ),
            const SizedBox(height: 12),
            Text('Connecting to driver…',
                style: AppTextStyles.bodySmall(color: AppColors.midGray)),
          ],
        ),
      );
    }

    final Widget card = state.step == BookingStep.arrived
        ? _ArrivalCard(driver: driver, pickupCode: state.pickupCode)
        : state.step == BookingStep.confirmed
            ? _LiveApproachCard(
                state: state,
                driver: driver,
                parentContext: context,
                ref: ref)
            : _OnTripCard(
                state: state,
                driver: driver,
                parentContext: context,
                ref: ref);

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Stage bar persists across confirmed/arrived/started — no animation here
        _JourneyStageBar(step: state.step),
        const SizedBox(height: 16),

        // Card-level transition only — stage bar stays put
        AnimatedSwitcher(
          duration: const Duration(milliseconds: 280),
          switchInCurve: Curves.easeOutCubic,
          switchOutCurve: Curves.easeInCubic,
          transitionBuilder: (child, animation) => FadeTransition(
            opacity: animation,
            child: SlideTransition(
              position: Tween<Offset>(
                      begin: const Offset(0, 0.04), end: Offset.zero)
                  .animate(animation),
              child: child,
            ),
          ),
          child: KeyedSubtree(key: ValueKey(state.step), child: card),
        ),

        // Arrived: compact driver contact strip below the plate card
        if (state.step == BookingStep.arrived) ...[
          const SizedBox(height: 10),
          _DriverContactRow(
              parentContext: context, driver: driver, state: state, ref: ref),
        ],

        // Cancel (not during active trip)
        if (state.step != BookingStep.started) ...[
          const SizedBox(height: 12),
          OutlinedButton(
            style: OutlinedButton.styleFrom(
              foregroundColor: AppColors.error,
              side: const BorderSide(color: AppColors.error),
              minimumSize: const Size(double.infinity, 48),
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(14)),
            ),
            onPressed: () =>
                ref.read(bookingControllerProvider.notifier).cancelBooking(),
            child: const Text('Cancel Trip'),
          ),
        ],
      ],
    );
  }

  // ── Nearby ETA helper ──────────────────────────────────────────────────

  static double _haversine(LatLng a, LatLng b) {
    const r = 6371000.0;
    final dLat = (b.latitude - a.latitude) * math.pi / 180;
    final dLon = (b.longitude - a.longitude) * math.pi / 180;
    final sinLat = math.sin(dLat / 2);
    final sinLon = math.sin(dLon / 2);
    final val = sinLat * sinLat +
        math.cos(a.latitude * math.pi / 180) *
            math.cos(b.latitude * math.pi / 180) *
            sinLon * sinLon;
    return r * 2 * math.atan2(math.sqrt(val), math.sqrt(1 - val));
  }

  // Groups confirmed/arrived/started under one key so the outer AnimatedSwitcher
  // only fires for major phase changes — not for each in-ride step update.
  static String _panelKey(BookingStep step) {
    if (step == BookingStep.confirmed ||
        step == BookingStep.arrived ||
        step == BookingStep.started) return 'ride_active';
    return step.toString();
  }
}

// ── Shared sub-widgets ─────────────────────────────────────────────────────

class _SheetHandle extends StatelessWidget {
  const _SheetHandle();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 12, bottom: 2),
      child: Center(
        child: Container(
          width: 40,
          height: 4,
          decoration: BoxDecoration(
            color: AppColors.border,
            borderRadius: BorderRadius.circular(2),
          ),
        ),
      ),
    );
  }
}

class _AddressRow extends StatelessWidget {
  final IconData icon;
  final Color iconColor;
  final String text;

  const _AddressRow({
    required this.icon,
    required this.iconColor,
    required this.text,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
      decoration: BoxDecoration(
        color: AppColors.paleGray,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        children: [
          Icon(icon, color: iconColor, size: 16),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              text,
              style: AppTextStyles.body(color: AppColors.charcoal),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );
  }
}

class _PrimaryButton extends StatelessWidget {
  final String label;
  final IconData? icon;
  final bool enabled;
  final VoidCallback onTap;

  const _PrimaryButton({
    required this.label,
    required this.onTap,
    this.icon,
    this.enabled = true,
  });

  @override
  Widget build(BuildContext context) {
    return AnimatedOpacity(
      duration: const Duration(milliseconds: 200),
      opacity: enabled ? 1.0 : 0.45,
      child: GestureDetector(
        onTap: enabled ? onTap : null,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 150),
          height: 54,
          decoration: BoxDecoration(
            color: enabled ? AppColors.primary : AppColors.paleGray,
            borderRadius: BorderRadius.circular(16),
            boxShadow: enabled
                ? [
                    BoxShadow(
                      color: AppColors.primary.withOpacity(0.3),
                      blurRadius: 12,
                      offset: const Offset(0, 4),
                    )
                  ]
                : null,
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              if (icon != null) ...[
                Icon(icon, size: 20, color: AppColors.charcoal),
                const SizedBox(width: 8),
              ],
              Text(
                label,
                style: AppTextStyles.button(color: AppColors.charcoal),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _NearbyEtaBanner extends StatelessWidget {
  final LatLng pickup;
  final List<LatLng> drivers;

  const _NearbyEtaBanner({required this.pickup, required this.drivers});

  @override
  Widget build(BuildContext context) {
    if (drivers.isEmpty) return const SizedBox.shrink();

    double nearest = double.infinity;
    for (final d in drivers) {
      final dist = BookingSheet._haversine(d, pickup);
      if (dist < nearest) nearest = dist;
    }
    final etaMins = ((nearest / 230).ceil()).clamp(1, 15);
    final etaText = etaMins == 1 ? '1 min' : '$etaMins mins';

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: AppColors.primary.withOpacity(0.12),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        children: [
          const Icon(Icons.electric_rickshaw,
              color: AppColors.primaryDark, size: 18),
          const SizedBox(width: 10),
          Text(
            'Nearest Keke ≈ $etaText away',
            style: AppTextStyles.bodySmall(
                color: AppColors.primaryDark, weight: FontWeight.w700),
          ),
          const Spacer(),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(
              color: AppColors.primary,
              borderRadius: BorderRadius.circular(8),
            ),
            child: Text(
              '${drivers.length} nearby',
              style: AppTextStyles.caption(
                  color: AppColors.charcoal, weight: FontWeight.w700),
            ),
          ),
        ],
      ),
    );
  }
}

class _InlineError extends StatelessWidget {
  final String message;
  const _InlineError({required this.message});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: AppColors.errorLight,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppColors.error.withOpacity(0.3)),
      ),
      child: Row(
        children: [
          const Icon(Icons.info_outline, color: AppColors.error, size: 16),
          const SizedBox(width: 8),
          Expanded(
              child: Text(message,
                  style: AppTextStyles.bodySmall(color: AppColors.error))),
        ],
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;
  const _ErrorState({required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 200,
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.wifi_off_rounded,
                size: 44, color: AppColors.lightGray),
            const SizedBox(height: 14),
            Text(message,
                style: AppTextStyles.bodySmall(),
                textAlign: TextAlign.center),
            const SizedBox(height: 18),
            _PrimaryButton(label: 'Try Again', onTap: onRetry),
          ],
        ),
      ),
    );
  }
}

// ── Searching animation ────────────────────────────────────────────────────

class _KekeSearchAnimation extends StatefulWidget {
  const _KekeSearchAnimation();

  @override
  State<_KekeSearchAnimation> createState() => _KekeSearchAnimationState();
}

class _KekeSearchAnimationState extends State<_KekeSearchAnimation>
    with SingleTickerProviderStateMixin {
  late AnimationController _ctrl;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1600),
    )..repeat();
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 80,
      height: 80,
      child: Stack(
        alignment: Alignment.center,
        children: [
          // Outer ring
          AnimatedBuilder(
            animation: _ctrl,
            builder: (_, __) {
              final t = _ctrl.value;
              return Opacity(
                opacity: (1 - t).clamp(0.0, 1.0),
                child: Transform.scale(
                  scale: 0.5 + t * 0.8,
                  child: Container(
                    width: 80,
                    height: 80,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(
                        color: AppColors.primary.withOpacity(0.3),
                        width: 2,
                      ),
                    ),
                  ),
                ),
              );
            },
          ),
          // Middle ring
          AnimatedBuilder(
            animation: _ctrl,
            builder: (_, __) {
              final t = ((_ctrl.value + 0.35) % 1.0);
              return Opacity(
                opacity: (1 - t).clamp(0.0, 1.0),
                child: Transform.scale(
                  scale: 0.5 + t * 0.8,
                  child: Container(
                    width: 80,
                    height: 80,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(
                        color: AppColors.primary.withOpacity(0.45),
                        width: 2,
                      ),
                    ),
                  ),
                ),
              );
            },
          ),
          // Center icon
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(
              color: AppColors.primary,
              shape: BoxShape.circle,
              boxShadow: [
                BoxShadow(
                  color: AppColors.primary.withOpacity(0.4),
                  blurRadius: 12,
                  offset: const Offset(0, 3),
                ),
              ],
            ),
            child: const Icon(Icons.electric_rickshaw,
                color: AppColors.charcoal, size: 24),
          ),
        ],
      ),
    );
  }
}

// ── Journey stage bar ─────────────────────────────────────────────────────

class _JourneyStageBar extends StatelessWidget {
  final BookingStep step;
  const _JourneyStageBar({required this.step});

  static const _labels = ['Accepted', 'Keke Coming', 'Arrived', 'Riding'];

  int get _activeIndex {
    switch (step) {
      case BookingStep.confirmed:
        return 1;
      case BookingStep.arrived:
        return 2;
      case BookingStep.started:
        return 3;
      default:
        return 0;
    }
  }

  @override
  Widget build(BuildContext context) {
    final active = _activeIndex;
    return Row(
      children: [
        for (int i = 0; i < _labels.length; i++) ...[
          if (i > 0)
            Expanded(
              child: Container(
                height: 2,
                color: i <= active ? AppColors.primary : AppColors.border,
              ),
            ),
          _StageNode(
            label: _labels[i],
            isActive: i == active,
            isDone: i < active,
          ),
        ],
      ],
    );
  }
}

class _StageNode extends StatelessWidget {
  final String label;
  final bool isActive;
  final bool isDone;
  const _StageNode(
      {required this.label, required this.isActive, required this.isDone});

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 22,
          height: 22,
          decoration: BoxDecoration(
            color: isActive || isDone ? AppColors.primary : AppColors.paleGray,
            shape: BoxShape.circle,
            border: Border.all(
              color: isActive || isDone ? AppColors.primary : AppColors.border,
              width: 2,
            ),
          ),
          child: isDone
              ? const Icon(Icons.check_rounded,
                  size: 12, color: AppColors.charcoal)
              : isActive
                  ? Center(
                      child: Container(
                        width: 8,
                        height: 8,
                        decoration: const BoxDecoration(
                          color: AppColors.charcoal,
                          shape: BoxShape.circle,
                        ),
                      ),
                    )
                  : null,
        ),
        const SizedBox(height: 4),
        Text(
          label,
          style: AppTextStyles.caption(
            color: isActive
                ? AppColors.primaryDark
                : isDone
                    ? AppColors.midGray
                    : AppColors.lightGray,
            weight: isActive ? FontWeight.w700 : FontWeight.normal,
          ),
        ),
      ],
    );
  }
}

// ── Live approach card (confirmed state) ───────────────────────────────────

class _LiveApproachCard extends StatelessWidget {
  final BookingState state;
  final Map<String, dynamic> driver;
  final BuildContext parentContext;
  final WidgetRef ref;

  const _LiveApproachCard({
    required this.state,
    required this.driver,
    required this.parentContext,
    required this.ref,
  });

  @override
  Widget build(BuildContext context) {
    final isNearby = state.isDriverNearby;
    final hasLocation = state.assignedDriverLocation != null;
    final eta = state.etaMinutes;
    final dist = state.distanceToPickupMeters;
    final name = driver['name'] as String? ?? 'Driver';
    final plate = driver['plate'] as String? ?? '—';
    final model = driver['model'] as String? ?? 'Keke';

    String etaStr = '—';
    String distStr = '—';
    if (isNearby) {
      etaStr = '< 1 min';
      distStr = 'Nearby';
    } else {
      if (eta != null && eta > 0) etaStr = '≈ ${eta.ceil()} min';
      if (dist != null) {
        distStr = dist < 1000
            ? '${dist.round()} m'
            : '${(dist / 1000).toStringAsFixed(1)} km';
      }
    }

    return Container(
      decoration: BoxDecoration(
        color: AppColors.white,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: AppColors.border),
        boxShadow: const [
          BoxShadow(
              color: Color(0x0E000000), blurRadius: 12, offset: Offset(0, 4))
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Status header
          Container(
            padding:
                const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
            decoration: BoxDecoration(
              color: isNearby ? AppColors.primary : AppColors.charcoal,
              borderRadius:
                  const BorderRadius.vertical(top: Radius.circular(20)),
            ),
            child: Row(
              children: [
                Icon(
                  isNearby
                      ? Icons.location_on_rounded
                      : Icons.electric_rickshaw,
                  color:
                      isNearby ? AppColors.charcoal : AppColors.primary,
                  size: 18,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        isNearby
                            ? 'Your Keke is almost here!'
                            : 'Your Keke is on the way',
                        style: AppTextStyles.body(
                          color: isNearby
                              ? AppColors.charcoal
                              : AppColors.white,
                          weight: FontWeight.w700,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      // Shown when driver GPS hasn't arrived yet
                      if (!hasLocation)
                        Text(
                          'Locating driver…',
                          style: AppTextStyles.caption(
                            color: isNearby
                                ? AppColors.charcoal.withOpacity(0.55)
                                : AppColors.lightGray,
                          ),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          ),

          // ETA + distance stat boxes
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 14, 14, 0),
            child: Row(
              children: [
                Expanded(
                  child: _StatBox(
                    icon: Icons.schedule_rounded,
                    label: 'ETA',
                    value: etaStr,
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: _StatBox(
                    icon: Icons.straighten_rounded,
                    label: 'Distance',
                    value: distStr,
                  ),
                ),
              ],
            ),
          ),

          const Padding(
            padding: EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            child: Divider(height: 1, color: AppColors.border),
          ),

          // Driver identity row
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
            child: Row(
              children: [
                Container(
                  width: 44,
                  height: 44,
                  decoration: const BoxDecoration(
                    color: AppColors.primary,
                    shape: BoxShape.circle,
                  ),
                  child: Center(
                    child: Text(
                      name.isNotEmpty ? name[0].toUpperCase() : 'D',
                      style: AppTextStyles.title(
                          color: AppColors.charcoal,
                          weight: FontWeight.w800),
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(name,
                          style: AppTextStyles.body(
                              weight: FontWeight.w700),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis),
                      Row(
                        children: [
                          ConstrainedBox(
                            constraints: const BoxConstraints(maxWidth: 110),
                            child: Container(
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 7, vertical: 2),
                              decoration: BoxDecoration(
                                color: AppColors.primary.withOpacity(0.12),
                                borderRadius: BorderRadius.circular(6),
                              ),
                              child: Text(
                                plate,
                                style: AppTextStyles.label(
                                    color: AppColors.primaryDark,
                                    weight: FontWeight.w800),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                          ),
                          const SizedBox(width: 6),
                          Flexible(
                            child: Text(model,
                                style: AppTextStyles.caption(),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    _CircleActionButton(
                      icon: Icons.chat_bubble_outline_rounded,
                      color: AppColors.primary,
                      badge: state.chatMessages.isNotEmpty
                          ? '${state.chatMessages.length}'
                          : null,
                      onTap: () => showModalBottomSheet(
                        context: parentContext,
                        isScrollControlled: true,
                        backgroundColor: Colors.transparent,
                        builder: (_) => SizedBox(
                          height: MediaQuery.of(parentContext).size.height *
                              0.6,
                          child: const RideChatPanel(),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    _CircleActionButton(
                      icon: Icons.call_rounded,
                      color: AppColors.success,
                      onTap: () => _call(parentContext, driver),
                    ),
                  ],
                ),
              ],
            ),
          ),

          // Ride code strip
          if (state.pickupCode != null) ...[
            Container(
              padding:
                  const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: const BoxDecoration(
                color: AppColors.paleGray,
                borderRadius:
                    BorderRadius.vertical(bottom: Radius.circular(20)),
              ),
              child: Row(
                children: [
                  const Icon(Icons.key_rounded,
                      size: 15, color: AppColors.midGray),
                  const SizedBox(width: 8),
                  Text('Ride code: ',
                      style:
                          AppTextStyles.caption(color: AppColors.midGray)),
                  Text(
                    state.pickupCode!,
                    style: AppTextStyles.label(
                        color: AppColors.charcoal,
                        weight: FontWeight.w900),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}

// ── Arrival card (arrived state — plate dominant) ──────────────────────────

class _ArrivalCard extends StatefulWidget {
  final Map<String, dynamic> driver;
  final String? pickupCode;
  const _ArrivalCard({required this.driver, this.pickupCode});

  @override
  State<_ArrivalCard> createState() => _ArrivalCardState();
}

class _ArrivalCardState extends State<_ArrivalCard>
    with SingleTickerProviderStateMixin {
  late AnimationController _pulse;
  late Animation<double> _scale;

  @override
  void initState() {
    super.initState();
    HapticFeedback.heavyImpact();
    _pulse = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1200),
    )..repeat(reverse: true);
    _scale = Tween<double>(begin: 0.985, end: 1.015).animate(
      CurvedAnimation(parent: _pulse, curve: Curves.easeInOut),
    );
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final plate = widget.driver['plate']?.toString() ?? '—';
    final name = widget.driver['name']?.toString() ?? '';
    final model = widget.driver['model']?.toString() ??
        widget.driver['vehicleModel']?.toString() ?? '';
    final code = widget.pickupCode;

    return Container(
      decoration: BoxDecoration(
        color: AppColors.charcoal,
        borderRadius: BorderRadius.circular(20),
        boxShadow: [
          BoxShadow(
            color: AppColors.primary.withOpacity(0.25),
            blurRadius: 20,
            offset: const Offset(0, 5),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Header — yellow background, bold
          Container(
            padding:
                const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
            decoration: const BoxDecoration(
              color: AppColors.primary,
              borderRadius:
                  BorderRadius.vertical(top: Radius.circular(20)),
            ),
            child: Row(
              children: [
                const Icon(Icons.check_circle_rounded,
                    color: AppColors.charcoal, size: 22),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    'Your Keke has arrived!',
                    style: AppTextStyles.body(
                        color: AppColors.charcoal,
                        weight: FontWeight.w800),
                  ),
                ),
                // Subtle live pulse dot
                ScaleTransition(
                  scale: _scale,
                  child: Container(
                    width: 10,
                    height: 10,
                    decoration: const BoxDecoration(
                      color: AppColors.charcoal,
                      shape: BoxShape.circle,
                    ),
                  ),
                ),
              ],
            ),
          ),

          // Plate number — oversized, max scannable
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 20, 14, 16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Look for this plate number',
                  style: AppTextStyles.bodySmall(color: AppColors.white),
                ),
                const SizedBox(height: 10),
                ScaleTransition(
                  scale: _scale,
                  child: Container(
                    width: double.infinity,
                    padding: const EdgeInsets.symmetric(
                        horizontal: 12, vertical: 16),
                    decoration: BoxDecoration(
                      color: AppColors.primary,
                      borderRadius: BorderRadius.circular(14),
                      boxShadow: [
                        BoxShadow(
                          color: AppColors.primary.withOpacity(0.35),
                          blurRadius: 16,
                          offset: const Offset(0, 4),
                        ),
                      ],
                    ),
                    child: FittedBox(
                      fit: BoxFit.scaleDown,
                      child: Text(
                        plate,
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                          fontSize: 34,
                          fontWeight: FontWeight.w900,
                          color: AppColors.charcoal,
                          letterSpacing: 5,
                        ),
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 10),
                Row(
                  children: [
                    const Icon(Icons.info_outline_rounded,
                        size: 14, color: AppColors.lightGray),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        'Match this plate before boarding',
                        style: AppTextStyles.caption(
                            color: AppColors.lightGray),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ],
                ),
                // Driver secondary identity — name + vehicle below plate
                if (name.isNotEmpty) ...[
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      Container(
                        width: 32,
                        height: 32,
                        decoration: const BoxDecoration(
                            color: AppColors.primary,
                            shape: BoxShape.circle),
                        child: Center(
                          child: Text(
                            name[0].toUpperCase(),
                            style: AppTextStyles.label(
                                color: AppColors.charcoal,
                                weight: FontWeight.w800),
                          ),
                        ),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              name,
                              style: AppTextStyles.bodySmall(
                                  color: AppColors.white,
                                  weight: FontWeight.w600),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                            if (model.isNotEmpty)
                              Text(
                                model,
                                style: AppTextStyles.caption(
                                    color: AppColors.lightGray),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ],
              ],
            ),
          ),

          // Ride code block
          if (code != null) ...[
            Container(
              margin: const EdgeInsets.fromLTRB(16, 4, 16, 16),
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: const Color(0xFF1E1E1E),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(
                    color: AppColors.primary.withOpacity(0.25)),
              ),
              child: Row(
                children: [
                  const Icon(Icons.key_rounded,
                      size: 16, color: AppColors.primary),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Tell your driver this code',
                            style: AppTextStyles.caption(
                                color: AppColors.midGray)),
                        const SizedBox(height: 2),
                        Text(
                          code,
                          style: AppTextStyles.headline(
                              color: AppColors.primary,
                              weight: FontWeight.w900),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}

// ── Driver contact row (compact — used below arrival card) ─────────────────

class _DriverContactRow extends StatelessWidget {
  final BuildContext parentContext;
  final Map<String, dynamic> driver;
  final BookingState state;
  final WidgetRef ref;

  const _DriverContactRow({
    required this.parentContext,
    required this.driver,
    required this.state,
    required this.ref,
  });

  @override
  Widget build(BuildContext context) {
    final name = driver['name'] as String? ?? 'Driver';
    final plate = driver['plate'] as String? ?? '—';
    final model = driver['model'] as String? ?? '—';

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: AppColors.surfaceVariant,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: const BoxDecoration(
                color: AppColors.primary, shape: BoxShape.circle),
            child: Center(
              child: Text(
                name.isNotEmpty ? name[0].toUpperCase() : 'D',
                style: AppTextStyles.body(
                    color: AppColors.charcoal, weight: FontWeight.w800),
              ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(name,
                    style: AppTextStyles.body(weight: FontWeight.w700),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis),
                Text(
                  model != '—' && model.isNotEmpty
                      ? '$plate · $model'
                      : plate,
                  style: AppTextStyles.bodySmall(),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          _CircleActionButton(
            icon: Icons.chat_bubble_outline_rounded,
            color: AppColors.primary,
            badge: state.chatMessages.isNotEmpty
                ? '${state.chatMessages.length}'
                : null,
            onTap: () => showModalBottomSheet(
              context: parentContext,
              isScrollControlled: true,
              backgroundColor: Colors.transparent,
              builder: (_) => SizedBox(
                height: MediaQuery.of(parentContext).size.height * 0.6,
                child: const RideChatPanel(),
              ),
            ),
          ),
          const SizedBox(width: 8),
          _CircleActionButton(
            icon: Icons.call_rounded,
            color: AppColors.success,
            onTap: () => _call(parentContext, driver),
          ),
        ],
      ),
    );
  }
}

// ── On-trip card (started state) ───────────────────────────────────────────

class _OnTripCard extends StatelessWidget {
  final BookingState state;
  final Map<String, dynamic> driver;
  final BuildContext parentContext;
  final WidgetRef ref;

  const _OnTripCard({
    required this.state,
    required this.driver,
    required this.parentContext,
    required this.ref,
  });

  @override
  Widget build(BuildContext context) {
    final name = driver['name'] as String? ?? 'Driver';
    final plate = driver['plate'] as String? ?? '—';
    final dest = state.destinationAddress;

    return Container(
      decoration: BoxDecoration(
        color: AppColors.white,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Status header — green
          Container(
            padding:
                const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
            decoration: const BoxDecoration(
              color: AppColors.success,
              borderRadius:
                  BorderRadius.vertical(top: Radius.circular(20)),
            ),
            child: Row(
              children: [
                const Icon(Icons.electric_rickshaw,
                    color: Colors.white, size: 20),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Trip in progress',
                          style: AppTextStyles.body(
                              color: Colors.white,
                              weight: FontWeight.w800)),
                      if (dest != null)
                        Text(
                          'To $dest',
                          style: AppTextStyles.caption(
                            color: Colors.white.withOpacity(0.8),
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                    ],
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(
                      horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: Colors.white.withOpacity(0.2),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        width: 5,
                        height: 5,
                        decoration: const BoxDecoration(
                            color: Colors.white, shape: BoxShape.circle),
                      ),
                      const SizedBox(width: 4),
                      Text('LIVE',
                          style: AppTextStyles.caption(
                              color: Colors.white,
                              weight: FontWeight.w700)),
                    ],
                  ),
                ),
              ],
            ),
          ),

          // Driver row with actions
          Padding(
            padding: const EdgeInsets.all(14),
            child: Row(
              children: [
                Container(
                  width: 44,
                  height: 44,
                  decoration: const BoxDecoration(
                    color: AppColors.primary,
                    shape: BoxShape.circle,
                  ),
                  child: Center(
                    child: Text(
                      name.isNotEmpty ? name[0].toUpperCase() : 'D',
                      style: AppTextStyles.title(
                          color: AppColors.charcoal,
                          weight: FontWeight.w800),
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(name,
                          style: AppTextStyles.body(
                              weight: FontWeight.w700),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis),
                      ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 130),
                        child: Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 7, vertical: 2),
                          decoration: BoxDecoration(
                            color: AppColors.primary.withOpacity(0.12),
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: Text(
                            plate,
                            style: AppTextStyles.label(
                                color: AppColors.primaryDark,
                                weight: FontWeight.w800),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                _CircleActionButton(
                  icon: Icons.chat_bubble_outline_rounded,
                  color: AppColors.primary,
                  badge: state.chatMessages.isNotEmpty
                      ? '${state.chatMessages.length}'
                      : null,
                  onTap: () => showModalBottomSheet(
                    context: parentContext,
                    isScrollControlled: true,
                    backgroundColor: Colors.transparent,
                    builder: (_) => SizedBox(
                      height:
                          MediaQuery.of(parentContext).size.height * 0.6,
                      child: const RideChatPanel(),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                _CircleActionButton(
                  icon: Icons.call_rounded,
                  color: AppColors.success,
                  onTap: () => _call(parentContext, driver),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ── Stat display box ───────────────────────────────────────────────────────

class _StatBox extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;
  const _StatBox(
      {required this.icon, required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    final isPending = value == '—';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: AppColors.paleGray,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 13, color: AppColors.midGray),
              const SizedBox(width: 5),
              Text(label,
                  style: AppTextStyles.caption(color: AppColors.midGray)),
            ],
          ),
          const SizedBox(height: 5),
          AnimatedSwitcher(
            duration: const Duration(milliseconds: 250),
            switchInCurve: Curves.easeOut,
            switchOutCurve: Curves.easeIn,
            transitionBuilder: (child, anim) =>
                FadeTransition(opacity: anim, child: child),
            child: isPending
                ? Text(
                    'Calculating…',
                    key: const ValueKey('pending'),
                    style:
                        AppTextStyles.bodySmall(color: AppColors.lightGray),
                  )
                : Text(
                    value,
                    key: ValueKey(value),
                    style: AppTextStyles.title(
                        color: AppColors.charcoal, weight: FontWeight.w800),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
          ),
        ],
      ),
    );
  }
}

// ── Shared call helper ─────────────────────────────────────────────────────

Future<void> _call(BuildContext context, Map<String, dynamic> driver) async {
  final phone = driver['phone']?.toString();
  if (phone == null || phone.isEmpty) {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text("Driver's phone number is unavailable")),
    );
    return;
  }
  final uri = Uri(scheme: 'tel', path: phone);
  if (await canLaunchUrl(uri)) await launchUrl(uri);
}

class _CircleActionButton extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String? badge;
  final VoidCallback onTap;

  const _CircleActionButton({
    required this.icon,
    required this.color,
    required this.onTap,
    this.badge,
  });

  @override
  Widget build(BuildContext context) {
    return Stack(
      clipBehavior: Clip.none,
      children: [
        GestureDetector(
          onTap: onTap,
          child: Container(
            width: 42,
            height: 42,
            decoration: BoxDecoration(
              color: color.withOpacity(0.12),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: color.withOpacity(0.25)),
            ),
            child: Icon(icon, color: color, size: 20),
          ),
        ),
        if (badge != null)
          Positioned(
            right: -4,
            top: -4,
            child: Container(
              padding: const EdgeInsets.all(3),
              decoration:
                  const BoxDecoration(color: AppColors.error, shape: BoxShape.circle),
              child: Text(badge!,
                  style: const TextStyle(
                      color: Colors.white,
                      fontSize: 9,
                      fontWeight: FontWeight.bold)),
            ),
          ),
      ],
    );
  }
}

// ── Payment method selector ────────────────────────────────────────────────

class _PaymentSelector extends StatelessWidget {
  final String selected;
  final double walletBalance;
  final int fare;
  final ValueChanged<String> onSelect;
  final VoidCallback onTopUp;

  const _PaymentSelector({
    required this.selected,
    required this.walletBalance,
    required this.fare,
    required this.onSelect,
    required this.onTopUp,
  });

  @override
  Widget build(BuildContext context) {
    final canAfford = walletBalance >= fare;
    final fmt = NumberFormat('#,###');

    return Row(
      children: [
        Expanded(
          child: _PaymentOption(
            label: 'Cash',
            subtitle: 'Pay on arrival',
            icon: Icons.payments_outlined,
            isSelected: selected == 'cash',
            isEnabled: true,
            onTap: () => onSelect('cash'),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Stack(
            clipBehavior: Clip.none,
            children: [
              _PaymentOption(
                label: 'Wallet',
                subtitle: canAfford
                    ? '₦${fmt.format(walletBalance)}'
                    : 'Insufficient',
                icon: Icons.account_balance_wallet_outlined,
                isSelected: selected == 'wallet',
                isEnabled: canAfford,
                onTap: canAfford ? () => onSelect('wallet') : null,
              ),
              if (!canAfford)
                Positioned(
                  right: 0,
                  top: -6,
                  child: GestureDetector(
                    onTap: onTopUp,
                    child: Container(
                      padding:
                          const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: AppColors.primary,
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: Text('Top Up',
                          style: AppTextStyles.caption(
                              color: AppColors.charcoal,
                              weight: FontWeight.w700)),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

class _PaymentOption extends StatelessWidget {
  final String label;
  final String subtitle;
  final IconData icon;
  final bool isSelected;
  final bool isEnabled;
  final VoidCallback? onTap;

  const _PaymentOption({
    required this.label,
    required this.subtitle,
    required this.icon,
    required this.isSelected,
    required this.isEnabled,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
        decoration: BoxDecoration(
          color: isSelected
              ? AppColors.primaryLight
              : (isEnabled ? AppColors.white : AppColors.surfaceVariant),
          border: Border.all(
            color: isSelected ? AppColors.primary : AppColors.border,
            width: isSelected ? 2 : 1,
          ),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Row(
          children: [
            Icon(icon,
                size: 20,
                color: isSelected
                    ? AppColors.primaryDark
                    : (isEnabled ? AppColors.midGray : AppColors.lightGray)),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(label,
                      style: AppTextStyles.body(
                          weight: FontWeight.w700,
                          color: isEnabled
                              ? AppColors.charcoal
                              : AppColors.lightGray)),
                  Text(subtitle,
                      style: AppTextStyles.caption(
                          color: isEnabled
                              ? AppColors.midGray
                              : AppColors.lightGray),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis),
                ],
              ),
            ),
            if (isSelected)
              const Icon(Icons.check_circle_rounded,
                  size: 16, color: AppColors.primaryDark),
          ],
        ),
      ),
    );
  }
}
