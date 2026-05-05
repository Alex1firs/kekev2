import 'package:flutter/material.dart';
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
          borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
          boxShadow: [BoxShadow(color: Color(0x18000000), blurRadius: 20, offset: Offset(0, -4))],
        ),
        child: SafeArea(
          top: false,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const _SheetHandle(),
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 16),
                child: AnimatedSwitcher(
                  duration: const Duration(milliseconds: 280),
                  switchInCurve: Curves.easeOutCubic,
                  switchOutCurve: Curves.easeInCubic,
                  transitionBuilder: (child, animation) => FadeTransition(
                    opacity: animation,
                    child: SlideTransition(
                      position: Tween<Offset>(begin: const Offset(0, 0.06), end: Offset.zero)
                          .animate(animation),
                      child: child,
                    ),
                  ),
                  child: KeyedSubtree(
                    key: ValueKey(state.step),
                    child: _buildPanelForState(context, ref, state),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildPanelForState(BuildContext context, WidgetRef ref, BookingState state) {
    switch (state.step) {
      case BookingStep.loading:
      case BookingStep.idle:
        return const SizedBox(
          height: 120,
          child: Center(child: CircularProgressIndicator()),
        );
      case BookingStep.selectingPickup:
        return _buildPickupPanel(context, ref, state);
      case BookingStep.selectingDestination:
        return _buildDestinationPanel(context, ref, state);
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

  // ── Pickup selection ─────────────────────────────────────────────────────
  Widget _buildPickupPanel(BuildContext context, WidgetRef ref, BookingState state) {
    final isMoving = state.isCameraMoving;
    final address = state.pickupAddress ?? 'Locating...';

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('Confirm Pickup', style: AppTextStyles.title()),
        const SizedBox(height: 14),
        _AddressRow(
          icon: Icons.radio_button_checked,
          iconColor: AppColors.primary,
          text: isMoving ? 'Moving map...' : address,
          onTap: isMoving ? null : () async {
            final result = await Navigator.push<Map<String, dynamic>>(
              context,
              MaterialPageRoute(builder: (_) => const DestinationSearchScreen(hintText: 'Enter Pickup Location')),
            );
            if (result != null) {
              ref.read(bookingControllerProvider.notifier).setPickup(
                result['address'] as String, result['location'] as LatLng);
            }
          },
        ),
        const SizedBox(height: 16),
        ElevatedButton(
          onPressed: isMoving || state.pickupLocation == null
              ? null
              : () => ref.read(bookingControllerProvider.notifier).confirmPickup(),
          child: const Text('Confirm Pickup'),
        ),
      ],
    );
  }

  // ── Destination selection ─────────────────────────────────────────────────
  Widget _buildDestinationPanel(BuildContext context, WidgetRef ref, BookingState state) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Text('Where to?', style: AppTextStyles.title()),
            const Spacer(),
            IconButton(
              icon: const Icon(Icons.close, color: AppColors.midGray),
              onPressed: () => ref.read(bookingControllerProvider.notifier).retreatToPickup(),
              visualDensity: VisualDensity.compact,
            ),
          ],
        ),
        const SizedBox(height: 12),
        _AddressRow(
          icon: Icons.radio_button_checked,
          iconColor: AppColors.primary,
          text: state.pickupAddress ?? 'Pickup',
          isSubtle: true,
        ),
        const SizedBox(height: 6),
        GestureDetector(
          onTap: () async {
            final result = await Navigator.push<Map<String, dynamic>>(
              context,
              MaterialPageRoute(builder: (_) => const DestinationSearchScreen()),
            );
            if (result != null) {
              ref.read(bookingControllerProvider.notifier).setDestination(
                result['address'] as String, result['location'] as LatLng);
            }
          },
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
            decoration: BoxDecoration(
              color: AppColors.paleGray,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppColors.border),
            ),
            child: Row(
              children: [
                const Icon(Icons.search, color: AppColors.midGray, size: 20),
                const SizedBox(width: 10),
                Text('Search destination...', style: AppTextStyles.body(color: AppColors.lightGray)),
              ],
            ),
          ),
        ),
        const SizedBox(height: 8),
      ],
    );
  }

  // ── Fare estimate ─────────────────────────────────────────────────────────
  Widget _buildFarePanel(BuildContext context, WidgetRef ref, BookingState state) {
    if (state.errorMessage != null && state.estimatedFareAmount == null) {
      return _ErrorState(
        message: state.errorMessage!,
        onRetry: () => ref.read(bookingControllerProvider.notifier).retreatToPickup(),
      );
    }
    if (state.estimatedFareAmount == null) {
      return const SizedBox(
        height: 180,
        child: Center(child: CircularProgressIndicator()),
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
              onTap: () => ref.read(bookingControllerProvider.notifier).retreatToPickup(),
              child: const Icon(Icons.arrow_back, color: AppColors.charcoal),
            ),
            const SizedBox(width: 12),
            Text('Your Ride', style: AppTextStyles.title()),
          ],
        ),
        const SizedBox(height: 16),

        // Keke fare card
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            gradient: LinearGradient(
              colors: [AppColors.primaryLight, AppColors.white],
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
            ),
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: AppColors.primary.withOpacity(0.4), width: 1.5),
          ),
          child: Row(
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: AppColors.primary,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: const Icon(Icons.electric_rickshaw, size: 26, color: AppColors.charcoal),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Keke Napep', style: AppTextStyles.body(weight: FontWeight.w700)),
                    Text('${state.estimatedTime ?? '—'} · ${state.estimatedDistance ?? '—'}',
                        style: AppTextStyles.bodySmall()),
                  ],
                ),
              ),
              Text(
                '₦${NumberFormat('#,###').format(state.estimatedFareAmount)}',
                style: AppTextStyles.headline(color: AppColors.primaryDark),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),

        Text('Pay with', style: AppTextStyles.label(weight: FontWeight.w600)),
        const SizedBox(height: 8),
        _PaymentSelector(
          selected: state.paymentMethod,
          walletBalance: walletState.balance,
          fare: state.estimatedFareAmount ?? 0,
          onSelect: (m) => ref.read(bookingControllerProvider.notifier).setPaymentMethod(m),
          onTopUp: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const WalletScreen())),
        ),
        const SizedBox(height: 16),

        ElevatedButton(
          onPressed: () => ref.read(bookingControllerProvider.notifier).requestRide(),
          child: const Text('Request Keke'),
        ),
      ],
    );
  }

  // ── Searching ─────────────────────────────────────────────────────────────
  Widget _buildSearchingPanel(BuildContext context, WidgetRef ref, BookingState state) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const SizedBox(height: 8),
        const SizedBox(
          width: 44,
          height: 44,
          child: CircularProgressIndicator(strokeWidth: 3, color: AppColors.primary),
        ),
        const SizedBox(height: 20),
        Text('Finding your driver...', style: AppTextStyles.title()),
        const SizedBox(height: 6),
        Text(
          'Connecting to nearby Keke drivers in Awka',
          style: AppTextStyles.bodySmall(),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 24),
        OutlinedButton(
          style: OutlinedButton.styleFrom(
            foregroundColor: AppColors.error,
            side: const BorderSide(color: AppColors.error),
          ),
          onPressed: () => ref.read(bookingControllerProvider.notifier).cancelBooking(),
          child: const Text('Cancel Request'),
        ),
        const SizedBox(height: 4),
      ],
    );
  }

  // ── Active ride ───────────────────────────────────────────────────────────
  Widget _buildRideActivePanel(BuildContext context, WidgetRef ref, BookingState state) {
    final driver = state.assignedDriver;
    if (driver == null) return const SizedBox(height: 80, child: Center(child: CircularProgressIndicator()));

    Color statusColor;
    String statusText;
    IconData statusIcon;

    switch (state.step) {
      case BookingStep.arrived:
        statusColor = AppColors.warning;
        statusText = 'Driver has arrived!';
        statusIcon = Icons.location_on;
        break;
      case BookingStep.started:
        statusColor = AppColors.success;
        statusText = 'On the way to destination';
        statusIcon = Icons.electric_rickshaw;
        break;
      default:
        statusColor = AppColors.success;
        statusText = 'Driver is on the way';
        statusIcon = Icons.directions;
    }

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: BoxDecoration(
            color: statusColor.withOpacity(0.1),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Row(
            children: [
              Icon(statusIcon, color: statusColor, size: 18),
              const SizedBox(width: 10),
              Text(statusText, style: AppTextStyles.bodySmall(color: statusColor, weight: FontWeight.w700)),
            ],
          ),
        ),
        const SizedBox(height: 14),

        // Driver card
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: AppColors.surfaceVariant,
            borderRadius: BorderRadius.circular(14),
          ),
          child: Row(
            children: [
              CircleAvatar(
                radius: 22,
                backgroundColor: AppColors.primaryLight,
                child: Text(
                  (driver['name'] as String? ?? 'D').substring(0, 1).toUpperCase(),
                  style: AppTextStyles.title(color: AppColors.primaryDark),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(driver['name'] ?? 'Driver', style: AppTextStyles.body(weight: FontWeight.w700)),
                    Text('${driver['model'] ?? '—'} · ${driver['plate'] ?? '—'}',
                        style: AppTextStyles.bodySmall()),
                  ],
                ),
              ),
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  _CircleActionButton(
                    icon: Icons.chat_bubble_outline_rounded,
                    color: AppColors.primary,
                    label: state.chatMessages.isNotEmpty ? '${state.chatMessages.length}' : null,
                    onTap: () => showModalBottomSheet(
                      context: context,
                      isScrollControlled: true,
                      backgroundColor: Colors.transparent,
                      builder: (_) => SizedBox(
                        height: MediaQuery.of(context).size.height * 0.6,
                        child: const RideChatPanel(),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  _CircleActionButton(
                    icon: Icons.call_rounded,
                    color: AppColors.success,
                    onTap: () async {
                      final phone = driver['phone']?.toString();
                      if (phone != null && phone.isNotEmpty) {
                        final uri = Uri(scheme: 'tel', path: phone);
                        if (await canLaunchUrl(uri)) await launchUrl(uri);
                      }
                    },
                  ),
                ],
              ),
            ],
          ),
        ),

        if (state.step != BookingStep.started) ...[
          const SizedBox(height: 12),
          OutlinedButton(
            style: OutlinedButton.styleFrom(
              foregroundColor: AppColors.error,
              side: const BorderSide(color: AppColors.error),
            ),
            onPressed: () => ref.read(bookingControllerProvider.notifier).cancelBooking(),
            child: const Text('Cancel Trip'),
          ),
        ],
      ],
    );
  }
}

// ── Shared sub-widgets ─────────────────────────────────────────────────────

class _SheetHandle extends StatelessWidget {
  const _SheetHandle();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 10, bottom: 2),
      child: Center(
        child: Container(
          width: 36, height: 4,
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
  final bool isSubtle;
  final VoidCallback? onTap;

  const _AddressRow({
    required this.icon,
    required this.iconColor,
    required this.text,
    this.isSubtle = false,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
        decoration: BoxDecoration(
          color: isSubtle ? AppColors.surfaceVariant : AppColors.paleGray,
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
                style: AppTextStyles.body(
                    color: isSubtle ? AppColors.midGray : AppColors.charcoal),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            if (onTap != null) const Icon(Icons.chevron_right, color: AppColors.lightGray, size: 18),
          ],
        ),
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
      height: 180,
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.wifi_off_rounded, size: 40, color: AppColors.lightGray),
            const SizedBox(height: 12),
            Text(message, style: AppTextStyles.bodySmall(), textAlign: TextAlign.center),
            const SizedBox(height: 16),
            ElevatedButton(onPressed: onRetry, child: const Text('Try Again')),
          ],
        ),
      ),
    );
  }
}

class _CircleActionButton extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String? label;
  final VoidCallback onTap;

  const _CircleActionButton({
    required this.icon,
    required this.color,
    required this.onTap,
    this.label,
  });

  @override
  Widget build(BuildContext context) {
    return Stack(
      clipBehavior: Clip.none,
      children: [
        GestureDetector(
          onTap: onTap,
          child: Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: color.withOpacity(0.12),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Icon(icon, color: color, size: 20),
          ),
        ),
        if (label != null)
          Positioned(
            right: -4,
            top: -4,
            child: Container(
              padding: const EdgeInsets.all(3),
              decoration: const BoxDecoration(color: AppColors.error, shape: BoxShape.circle),
              child: Text(label!, style: const TextStyle(color: Colors.white, fontSize: 9, fontWeight: FontWeight.bold)),
            ),
          ),
      ],
    );
  }
}

// ── Payment Method Selector ────────────────────────────────────────────────

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
    final canAffordWallet = walletBalance >= fare;
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
                subtitle: canAffordWallet ? '₦${fmt.format(walletBalance)}' : 'Insufficient',
                icon: Icons.account_balance_wallet_outlined,
                isSelected: selected == 'wallet',
                isEnabled: canAffordWallet,
                onTap: canAffordWallet ? () => onSelect('wallet') : null,
              ),
              if (!canAffordWallet)
                Positioned(
                  right: 0,
                  top: -6,
                  child: GestureDetector(
                    onTap: onTopUp,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: AppColors.primary,
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: Text('Top Up',
                          style: AppTextStyles.caption(color: AppColors.charcoal, weight: FontWeight.w700)),
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
                          color: isEnabled ? AppColors.charcoal : AppColors.lightGray)),
                  Text(subtitle,
                      style: AppTextStyles.caption(
                          color: isEnabled ? AppColors.midGray : AppColors.lightGray),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis),
                ],
              ),
            ),
            if (isSelected)
              const Icon(Icons.check_circle_rounded, size: 16, color: AppColors.primaryDark),
          ],
        ),
      ),
    );
  }
}
