import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../../../../core/theme/app_theme.dart';
import '../../application/driver_controller.dart';
import '../../domain/driver_profile.dart';
import '../../domain/driver_state.dart';
import 'ride_chat_panel.dart';
import 'sos_sheet.dart';

class TripOperationHUD extends ConsumerWidget {
  final DriverState state;

  const TripOperationHUD({super.key, required this.state});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (state.activeRequest == null) return const SizedBox.shrink();

    return Positioned(
      bottom: 0,
      left: 0,
      right: 0,
      child: Container(
        decoration: const BoxDecoration(
          color: AppColors.charcoal,
          borderRadius: BorderRadius.only(
            topLeft: Radius.circular(28),
            topRight: Radius.circular(28),
          ),
          boxShadow: [
            BoxShadow(
                color: Color(0x55000000),
                blurRadius: 28,
                offset: Offset(0, -4)),
          ],
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const _SheetHandle(),
            ConstrainedBox(
              constraints: BoxConstraints(
                maxHeight: MediaQuery.of(context).size.height * 0.70,
              ),
              child: SingleChildScrollView(
                physics: const BouncingScrollPhysics(),
                padding: const EdgeInsets.fromLTRB(24, 4, 24, 28),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    // Trip phase progress
                    if (state.tripStep != TripStep.completed) ...[
                      _TripPhaseBar(step: state.tripStep),
                      const SizedBox(height: 16),
                    ],

                    // Status + address + fare
                    _buildHeader(),
                    const SizedBox(height: 12),

                    // Live ETA + distance row
                    if (state.tripStep == TripStep.accepted ||
                        state.tripStep == TripStep.arrived ||
                        state.tripStep == TripStep.started) ...[
                      _buildEtaRow(),
                      const SizedBox(height: 12),
                    ],

                    // Main action or completion panel
                    if (state.tripStep != TripStep.completed)
                      _buildMainAction(context, ref),
                    if (state.tripStep == TripStep.completed)
                      _buildCompletionPanel(ref),

                    // Pickup code when at/near pickup
                    if ((state.tripStep == TripStep.accepted ||
                            state.tripStep == TripStep.arrived) &&
                        state.activeRequest?.pickupCode != null) ...[
                      const SizedBox(height: 12),
                      _buildPickupCodeCard(state.activeRequest!.pickupCode!),
                    ],

                    const SizedBox(height: 14),
                    _buildPassengerRow(context),

                    if (state.tripStep != TripStep.completed) ...[
                      const SizedBox(height: 14),
                      _buildSosButton(context),
                    ],
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildHeader() {
    final req = state.activeRequest!;
    final isOnTrip = state.tripStep == TripStep.started;
    final address =
        isOnTrip ? req.destinationAddress : req.pickupAddress;

    String statusLabel;
    Color statusBg;
    Color statusFg;

    switch (state.tripStep) {
      case TripStep.accepted:
        statusLabel = 'Heading to Pickup';
        statusBg = const Color(0xFF1E3A5F);
        statusFg = const Color(0xFF93C5FD);
        break;
      case TripStep.arrived:
        statusLabel = 'Waiting at Pickup';
        statusBg = AppColors.primaryLight;
        statusFg = AppColors.primaryDark;
        break;
      case TripStep.started:
        statusLabel = 'On Trip';
        statusBg = const Color(0xFF064E3B);
        statusFg = const Color(0xFF6EE7B7);
        break;
      case TripStep.completed:
        statusLabel = 'Trip Completed';
        statusBg = const Color(0xFF064E3B);
        statusFg = const Color(0xFF6EE7B7);
        break;
      default:
        return const SizedBox.shrink();
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Container(
              padding:
                  const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              decoration: BoxDecoration(
                color: statusBg,
                borderRadius: BorderRadius.circular(20),
              ),
              child: Text(statusLabel,
                  style: AppTextStyles.caption(
                      color: statusFg, weight: FontWeight.w700)),
            ),
            const Spacer(),
            // Fare chip
            Container(
              padding:
                  const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              decoration: BoxDecoration(
                color: AppColors.darkGray,
                borderRadius: BorderRadius.circular(20),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    '₦${req.fare.toInt()}',
                    style: AppTextStyles.body(
                        color: AppColors.primary, weight: FontWeight.w700),
                  ),
                  const SizedBox(width: 6),
                  Container(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 6, vertical: 2),
                    decoration: BoxDecoration(
                      color: req.isCash
                          ? const Color(0xFF065F46)
                          : AppColors.charcoal,
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Text(
                      req.isCash ? 'Cash' : 'Wallet',
                      style: AppTextStyles.caption(
                        color: req.isCash
                            ? const Color(0xFF6EE7B7)
                            : AppColors.lightGray,
                        weight: FontWeight.w700,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        Text(
          address.isNotEmpty ? address : '—',
          style: AppTextStyles.title(color: AppColors.white),
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
        ),
      ],
    );
  }

  Widget _buildEtaRow() {
    final eta = state.routeEtaMinutes;
    final dist = state.routeDistanceMeters;
    final etaText = eta != null ? '≈ ${eta.round()} min' : '—';
    final distText = dist != null
        ? dist >= 1000
            ? '${(dist / 1000).toStringAsFixed(1)} km'
            : '${dist.round()} m'
        : '—';
    final label = state.tripStep == TripStep.started ? 'To destination' : 'To pickup';

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: AppColors.darkGray,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        children: [
          const Icon(Icons.schedule_rounded, color: AppColors.primary, size: 16),
          const SizedBox(width: 8),
          Text(
            etaText,
            style: AppTextStyles.body(color: AppColors.white, weight: FontWeight.w700),
          ),
          const SizedBox(width: 16),
          const Icon(Icons.straighten_rounded, color: AppColors.lightGray, size: 16),
          const SizedBox(width: 6),
          Text(
            distText,
            style: AppTextStyles.body(color: AppColors.lightGray),
          ),
          const Spacer(),
          Text(
            label,
            style: AppTextStyles.caption(color: AppColors.midGray),
          ),
        ],
      ),
    );
  }

  Widget _buildMainAction(BuildContext context, WidgetRef ref) {
    String text;
    Color bgColor;
    Color fgColor;
    IconData icon;
    VoidCallback? onPressed;

    switch (state.tripStep) {
      case TripStep.accepted:
        text = 'I Have Arrived';
        bgColor = AppColors.primary;
        fgColor = AppColors.charcoal;
        icon = Icons.location_on_rounded;
        onPressed = () =>
            ref.read(driverControllerProvider.notifier).markArrived();
        break;
      case TripStep.arrived:
        text = 'Start Trip';
        bgColor = AppColors.primary;
        fgColor = AppColors.charcoal;
        icon = Icons.play_arrow_rounded;
        onPressed = () =>
            ref.read(driverControllerProvider.notifier).startTrip();
        break;
      case TripStep.started:
        if (state.awaitingEarlyEndConfirmation) {
          text = 'Waiting for passenger…';
          bgColor = AppColors.midGray;
          fgColor = AppColors.white;
          icon = Icons.hourglass_top_rounded;
          onPressed = null; // waiting on passenger confirmation
        } else {
          text = 'End Trip';
          bgColor = AppColors.error;
          fgColor = AppColors.white;
          icon = Icons.stop_rounded;
          onPressed = () {
            if (state.activeRequest!.isCash) {
              _showCashConfirmDialog(context, ref);
            } else {
              ref.read(driverControllerProvider.notifier).completeTrip();
            }
          };
        }
        break;
      default:
        return const SizedBox.shrink();
    }

    return ElevatedButton(
      style: ElevatedButton.styleFrom(
        backgroundColor: bgColor,
        foregroundColor: fgColor,
        padding: const EdgeInsets.symmetric(vertical: 18),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        elevation: 0,
      ),
      onPressed: onPressed,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(icon, size: 22),
          const SizedBox(width: 8),
          Text(text,
              style: AppTextStyles.body(
                  color: fgColor, weight: FontWeight.w700)),
        ],
      ),
    );
  }

  Widget _buildCompletionPanel(WidgetRef ref) {
    final isCash = state.activeRequest?.isCash ?? false;
    final fare = state.activeRequest?.fare ?? 0;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.all(18),
          decoration: BoxDecoration(
            color: const Color(0xFF064E3B),
            borderRadius: BorderRadius.circular(16),
          ),
          child: Column(
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(Icons.check_circle_rounded,
                      color: Color(0xFF6EE7B7), size: 24),
                  const SizedBox(width: 10),
                  Text(
                    'Trip Complete',
                    style: AppTextStyles.title(
                        color: const Color(0xFF6EE7B7),
                        weight: FontWeight.w700),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Text(
                isCash
                    ? 'Cash received: ₦${fare.toInt()}'
                    : '₦${fare.toInt()} captured from wallet',
                style: AppTextStyles.body(
                    color: const Color(0xFF6EE7B7).withOpacity(0.8)),
                textAlign: TextAlign.center,
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        ElevatedButton(
          style: ElevatedButton.styleFrom(
            backgroundColor: AppColors.white,
            foregroundColor: AppColors.charcoal,
            padding: const EdgeInsets.symmetric(vertical: 18),
            shape:
                RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
            elevation: 0,
          ),
          onPressed: () =>
              ref.read(driverControllerProvider.notifier).finishAndGoAvailable(),
          child: Text('Back to Available',
              style: AppTextStyles.body(
                  color: AppColors.charcoal, weight: FontWeight.w700)),
        ),
      ],
    );
  }

  Widget _buildPickupCodeCard(String code) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: BoxDecoration(
        color: AppColors.darkGray,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.primary.withOpacity(0.5)),
      ),
      child: Row(
        children: [
          Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              color: AppColors.primary.withOpacity(0.15),
              borderRadius: BorderRadius.circular(10),
            ),
            child: const Icon(Icons.key_rounded,
                size: 18, color: AppColors.primary),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Ride code — ask your passenger',
                    style: AppTextStyles.caption(color: AppColors.midGray)),
                const SizedBox(height: 2),
                Text(
                  code,
                  style: AppTextStyles.title(
                      color: AppColors.primary, weight: FontWeight.w900),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildPassengerRow(BuildContext context) {
    final unread = state.chatMessages.where((m) => m.isPassenger).length;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: AppColors.darkGray,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Row(
        children: [
          Container(
            width: 42,
            height: 42,
            decoration: const BoxDecoration(
              color: AppColors.charcoal,
              shape: BoxShape.circle,
            ),
            child: const Icon(Icons.person, color: AppColors.lightGray, size: 20),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              state.activeRequest!.passengerName,
              style: AppTextStyles.body(
                  color: AppColors.white, weight: FontWeight.w600),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          // Chat
          Stack(
            clipBehavior: Clip.none,
            children: [
              _ActionCircle(
                icon: Icons.chat_bubble_outline,
                color: AppColors.primary,
                onTap: () => showModalBottomSheet(
                  context: context,
                  isScrollControlled: true,
                  backgroundColor: Colors.transparent,
                  builder: (ctx) => SizedBox(
                    height: MediaQuery.of(ctx).size.height * 0.6 +
                        MediaQuery.of(ctx).viewInsets.bottom,
                    child: const RideChatPanel(),
                  ),
                ),
              ),
              if (unread > 0)
                Positioned(
                  right: 0,
                  top: 0,
                  child: Container(
                    constraints: const BoxConstraints(minWidth: 16, minHeight: 16),
                    padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
                    decoration: BoxDecoration(
                      color: AppColors.error,
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Text(
                      unread > 99 ? '99+' : '$unread',
                      style: const TextStyle(
                          color: AppColors.white,
                          fontSize: 10,
                          fontWeight: FontWeight.w700),
                      textAlign: TextAlign.center,
                    ),
                  ),
                ),
            ],
          ),
          const SizedBox(width: 10),
          // Call
          _ActionCircle(
            icon: Icons.phone_rounded,
            color: AppColors.success,
            onTap: () async {
              String phone = state.activeRequest?.passengerPhone ?? '';
              if (phone.isEmpty) {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(
                      content: Text("Passenger's phone number is unavailable")),
                );
                return;
              }
              phone = phone.replaceAll(RegExp(r'\s+'), '');
              if (phone.startsWith('+234')) {
                phone = '0${phone.substring(4)}';
              } else if (phone.startsWith('234')) {
                phone = '0${phone.substring(3)}';
              }
              final uri = Uri(scheme: 'tel', path: phone);
              if (await canLaunchUrl(uri)) await launchUrl(uri);
            },
          ),
        ],
      ),
    );
  }

  void _showCashConfirmDialog(BuildContext context, WidgetRef ref) {
    final fare = state.activeRequest?.fare ?? 0;
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        backgroundColor: AppColors.charcoal,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: Text('Confirm Cash Received',
            style: AppTextStyles.title(color: AppColors.white)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: AppColors.darkGray,
                borderRadius: BorderRadius.circular(14),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(Icons.payments_rounded,
                      color: AppColors.primary, size: 28),
                  const SizedBox(width: 12),
                  Text(
                    '₦${fare.toStringAsFixed(0)}',
                    style: AppTextStyles.headline(
                        color: AppColors.primary, weight: FontWeight.w800),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 14),
            Text(
              'Did you physically collect this cash from the passenger?',
              style: AppTextStyles.body(color: AppColors.lightGray),
              textAlign: TextAlign.center,
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text('No — Go Back',
                style: AppTextStyles.body(color: AppColors.error)),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: AppColors.success,
              foregroundColor: AppColors.white,
              shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12)),
            ),
            onPressed: () {
              Navigator.pop(ctx);
              ref.read(driverControllerProvider.notifier).completeTrip();
            },
            child: Text('Yes — Confirm',
                style: AppTextStyles.body(
                    color: AppColors.white, weight: FontWeight.w700)),
          ),
        ],
      ),
    );
  }

  Widget _buildSosButton(BuildContext context) {
    return GestureDetector(
      onTap: () => SosSheet.show(context),
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 14),
        decoration: BoxDecoration(
          color: AppColors.error.withOpacity(0.1),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: AppColors.error.withOpacity(0.3)),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.emergency_share_rounded, color: AppColors.error, size: 20),
            const SizedBox(width: 8),
            Text('Emergency SOS', style: AppTextStyles.button(color: AppColors.error)),
          ],
        ),
      ),
    );
  }
}

// ─── Trip phase progress bar ────────────────────────────────────────────────

class _TripPhaseBar extends StatelessWidget {
  final TripStep step;

  const _TripPhaseBar({required this.step});

  @override
  Widget build(BuildContext context) {
    final phases = ['Pickup', 'Arrived', 'On Trip'];
    final activeIndex = step == TripStep.accepted
        ? 0
        : step == TripStep.arrived
            ? 1
            : 2;

    return Row(
      children: [
        for (int i = 0; i < phases.length; i++) ...[
          _PhaseNode(
            label: phases[i],
            isActive: activeIndex == i,
            isDone: activeIndex > i,
          ),
          if (i < phases.length - 1)
            Expanded(
              child: Container(
                height: 2,
                margin: const EdgeInsets.only(bottom: 16),
                color: activeIndex > i
                    ? AppColors.primary
                    : AppColors.darkGray,
              ),
            ),
        ],
      ],
    );
  }
}

class _PhaseNode extends StatelessWidget {
  final String label;
  final bool isActive;
  final bool isDone;

  const _PhaseNode(
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
            color: isDone
                ? AppColors.primary
                : isActive
                    ? AppColors.primary
                    : AppColors.darkGray,
            shape: BoxShape.circle,
            border: isActive && !isDone
                ? Border.all(color: AppColors.primary.withOpacity(0.4), width: 4)
                : null,
          ),
          child: isDone
              ? const Icon(Icons.check_rounded,
                  color: AppColors.charcoal, size: 13)
              : null,
        ),
        const SizedBox(height: 4),
        Text(
          label,
          style: AppTextStyles.caption(
            color:
                isActive || isDone ? AppColors.primary : AppColors.midGray,
            weight: isActive ? FontWeight.w700 : FontWeight.w400,
          ),
        ),
      ],
    );
  }
}

// ─── Shared sub-widgets ──────────────────────────────────────────────────────

class _SheetHandle extends StatelessWidget {
  const _SheetHandle();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 12, bottom: 4),
      child: Center(
        child: Container(
          width: 36,
          height: 4,
          decoration: BoxDecoration(
            color: AppColors.darkGray,
            borderRadius: BorderRadius.circular(2),
          ),
        ),
      ),
    );
  }
}

class _ActionCircle extends StatelessWidget {
  final IconData icon;
  final Color color;
  final VoidCallback onTap;

  const _ActionCircle(
      {required this.icon, required this.color, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 42,
        height: 42,
        decoration: BoxDecoration(
          color: color.withOpacity(0.15),
          shape: BoxShape.circle,
        ),
        child: Icon(icon, color: color, size: 20),
      ),
    );
  }
}
