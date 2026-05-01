import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';
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
          color: Colors.white,
          borderRadius: BorderRadius.only(
            topLeft: Radius.circular(24),
            topRight: Radius.circular(24),
          ),
          boxShadow: [BoxShadow(color: Colors.black12, blurRadius: 10, offset: Offset(0, -2))],
        ),
        child: SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
            child: AnimatedSwitcher(
              duration: const Duration(milliseconds: 300),
              child: _buildPanelForState(context, ref, state),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildPanelForState(BuildContext context, WidgetRef ref, BookingState state) {
    switch (state.step) {
      case BookingStep.loading:
      case BookingStep.idle:
        return const SizedBox(height: 120, child: Center(child: CircularProgressIndicator()));
        
      case BookingStep.selectingPickup:
        return _buildPickupSelection(context, ref, state);
        
      case BookingStep.selectingDestination:
        return _buildDestinationSelection(context, ref, state);
        
      case BookingStep.previewEstimate:
        return _buildFareEstimate(context, ref, state);

      case BookingStep.searching:
        return _buildSearchingPanel(context, ref, state);
        
      case BookingStep.confirmed:
      case BookingStep.arrived:
      case BookingStep.started:
        return _buildConfirmedPanel(context, ref, state);

      case BookingStep.completed:
        return const RideReceiptSheet();
    }
  }

  Widget _buildPickupSelection(BuildContext context, WidgetRef ref, BookingState state) {
    final isMoving = state.isCameraMoving;
    final address = state.pickupAddress ?? 'Locating...';

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text('Confirm Your Pickup', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
        const SizedBox(height: 12),
        InkWell(
          onTap: isMoving ? null : () async {
            final result = await Navigator.push(
              context,
              MaterialPageRoute(builder: (context) => const DestinationSearchScreen(hintText: 'Enter Pickup Location')),
            );
            if (result != null && result is Map<String, dynamic>) {
              ref.read(bookingControllerProvider.notifier).setPickup(
                    result['address'] as String,
                    result['location'] as LatLng,
                  );
            }
          },
          borderRadius: BorderRadius.circular(8),
          child: Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: Colors.grey.shade100, borderRadius: BorderRadius.circular(8)),
            child: Row(
              children: [
                const Icon(Icons.circle, color: Colors.amber, size: 16),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    isMoving ? 'Moving map...' : address,
                    style: const TextStyle(fontSize: 16),
                    maxLines: 1, 
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
          ),
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

  Widget _buildDestinationSelection(BuildContext context, WidgetRef ref, BookingState state) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            const Text('Where to?', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
            IconButton(
              icon: const Icon(Icons.close),
              onPressed: () => ref.read(bookingControllerProvider.notifier).retreatToPickup(),
            )
          ],
        ),
        const SizedBox(height: 12),
        ListTile(
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
          tileColor: Colors.grey.shade100,
          leading: const Icon(Icons.search),
          title: const Text('Search Destination...'),
          onTap: () async {
            final result = await Navigator.push(
              context,
              MaterialPageRoute(builder: (context) => const DestinationSearchScreen()),
            );
            if (result != null && result is Map<String, dynamic>) {
              ref.read(bookingControllerProvider.notifier).setDestination(
                    result['address'] as String,
                    result['location'] as LatLng,
                  );
            }
          },
        ),
        const SizedBox(height: 12),
      ],
    );
  }

  Widget _buildFareEstimate(BuildContext context, WidgetRef ref, BookingState state) {
    if (state.errorMessage != null && state.estimatedFareAmount == null) {
      return SizedBox(
        height: 180,
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(state.errorMessage!, style: const TextStyle(color: Colors.red)),
              const SizedBox(height: 16),
              ElevatedButton(
                onPressed: () => ref.read(bookingControllerProvider.notifier).retreatToPickup(),
                child: const Text('Try Again'),
              ),
            ],
          ),
        ),
      );
    }
    if (state.estimatedFareAmount == null) {
      return const SizedBox(height: 180, child: Center(child: CircularProgressIndicator()));
    }

    final walletState = ref.watch(walletControllerProvider);

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            IconButton(
              icon: const Icon(Icons.arrow_back),
              onPressed: () => ref.read(bookingControllerProvider.notifier).retreatToPickup(),
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints(),
            ),
            const SizedBox(width: 12),
            const Text('Ride Details', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
          ],
        ),
        const SizedBox(height: 16),
        
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            border: Border.all(color: Colors.amber.shade300, width: 2),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Keke Ride', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                  Text('${state.estimatedTime} • ${state.estimatedDistance}', style: const TextStyle(color: Colors.grey)),
                ],
              ),
              Text('₦${state.estimatedFareAmount}', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
            ],
          ),
        ),
        const SizedBox(height: 16),

        // Payment method selector
        const Text('Pay with', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13, color: Colors.black54)),
        const SizedBox(height: 8),
        _PaymentSelector(
          selected: state.paymentMethod,
          walletBalance: walletState.balance,
          fare: state.estimatedFareAmount ?? 0,
          onSelect: (method) =>
              ref.read(bookingControllerProvider.notifier).setPaymentMethod(method),
          onTopUp: () => Navigator.push(
            context,
            MaterialPageRoute(builder: (_) => const WalletScreen()),
          ),
        ),

        const SizedBox(height: 16),
        ElevatedButton(
          style: ElevatedButton.styleFrom(backgroundColor: Colors.amber, foregroundColor: Colors.black),
          onPressed: () => ref.read(bookingControllerProvider.notifier).requestRide(),
          child: const Padding(
            padding: EdgeInsets.symmetric(vertical: 12.0),
            child: Text('REQUEST KEKE', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
          ),
        ),
      ],
    );
  }

  Widget _buildSearchingPanel(BuildContext context, WidgetRef ref, BookingState state) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const SizedBox(height: 20),
        const CircularProgressIndicator(color: Colors.amber),
        const SizedBox(height: 24),
        const Text('Finding your driver...', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
        const SizedBox(height: 8),
        const Text('Connecting to nearby available Keke drivers in Awka', style: TextStyle(color: Colors.grey)),
        const SizedBox(height: 24),
        TextButton(
          onPressed: () => ref.read(bookingControllerProvider.notifier).cancelBooking(),
          child: const Text('Cancel Request', style: TextStyle(color: Colors.redAccent)),
        ),
      ],
    );
  }

  Widget _buildConfirmedPanel(BuildContext context, WidgetRef ref, BookingState state) {
    final driver = state.assignedDriver;
    if (driver == null) return const SizedBox.shrink();

    String titleText = 'Driver Assigned!';
    Color titleColor = Colors.green;
    
    if (state.step == BookingStep.arrived) {
      titleText = 'Driver has arrived!';
      titleColor = Colors.amber.shade700;
    } else if (state.step == BookingStep.started) {
      titleText = 'Heading to destination...';
      titleColor = Colors.blue;
    }

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(titleText, style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: titleColor)),
        const SizedBox(height: 16),
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const CircleAvatar(child: Icon(Icons.person)),
          title: Text(driver['name'] ?? 'Driver', style: const TextStyle(fontWeight: FontWeight.bold)),
          subtitle: Text('${driver['model']} • ${driver['plate']}'),
          trailing: IconButton(
            icon: const Icon(Icons.call, color: Colors.green),
            onPressed: () async {
              final phone = driver['phone']?.toString();
              if (phone != null && phone.isNotEmpty) {
                final uri = Uri(scheme: 'tel', path: phone);
                if (await canLaunchUrl(uri)) await launchUrl(uri);
              }
            },
          ),
        ),
        const SizedBox(height: 12),

        // Chat button — opens the in-ride chat panel
        OutlinedButton.icon(
          icon: const Icon(Icons.chat_bubble_outline),
          label: Text(state.chatMessages.isEmpty ? 'Chat with Driver' : 'Chat (${state.chatMessages.length})'),
          onPressed: () => showModalBottomSheet(
            context: context,
            isScrollControlled: true,
            backgroundColor: Colors.transparent,
            builder: (_) => SizedBox(
              height: MediaQuery.of(context).size.height * 0.6,
              child: const RideChatPanel(),
            ),
          ),
        ),

        if (state.step != BookingStep.started) ...[
          const SizedBox(height: 8),
          ElevatedButton(
            onPressed: () => ref.read(bookingControllerProvider.notifier).cancelBooking(),
            child: const Text('Cancel Trip'),
          ),
        ],
      ],
    );
  }
}

// ─── Payment Method Selector ─────────────────────────────────────────────────

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
    final fmt = NumberFormat('#,###.00');

    return Row(
      children: [
        // Cash option
        Expanded(
          child: _PaymentOption(
            label: 'Cash',
            subtitle: 'Pay on arrival',
            icon: Icons.money,
            isSelected: selected == 'cash',
            isEnabled: true,
            onTap: () => onSelect('cash'),
          ),
        ),
        const SizedBox(width: 10),
        // Wallet option
        Expanded(
          child: Stack(
            clipBehavior: Clip.none,
            children: [
              _PaymentOption(
                label: 'Wallet',
                subtitle: canAffordWallet
                    ? '₦${fmt.format(walletBalance)}'
                    : 'Insufficient funds',
                icon: Icons.account_balance_wallet_outlined,
                isSelected: selected == 'wallet',
                isEnabled: canAffordWallet,
                onTap: canAffordWallet ? () => onSelect('wallet') : null,
              ),
              if (!canAffordWallet)
                Positioned(
                  right: 0,
                  top: 0,
                  child: GestureDetector(
                    onTap: onTopUp,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      decoration: BoxDecoration(
                        color: const Color(0xFFFFC107),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: const Text('Top Up',
                          style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
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
    final selectedColor = const Color(0xFFFFC107);
    final disabledColor = Colors.grey[200];

    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: isSelected ? selectedColor.withOpacity(0.15) : (isEnabled ? Colors.white : disabledColor),
          border: Border.all(
            color: isSelected ? selectedColor : Colors.grey.shade300,
            width: isSelected ? 2 : 1,
          ),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Row(
          children: [
            Icon(icon,
                size: 22,
                color: isSelected
                    ? Colors.amber.shade800
                    : (isEnabled ? Colors.black54 : Colors.grey)),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(label,
                      style: TextStyle(
                        fontWeight: FontWeight.w700,
                        fontSize: 14,
                        color: isEnabled ? Colors.black : Colors.grey,
                      )),
                  Text(subtitle,
                      style: TextStyle(
                        fontSize: 11,
                        color: isEnabled ? Colors.black54 : Colors.grey,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis),
                ],
              ),
            ),
            if (isSelected)
              Icon(Icons.check_circle, size: 18, color: Colors.amber.shade800),
          ],
        ),
      ),
    );
  }
}
