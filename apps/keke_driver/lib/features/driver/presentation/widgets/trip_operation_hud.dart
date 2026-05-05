import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../../../../core/theme/app_theme.dart';
import '../../application/driver_controller.dart';
import '../../domain/driver_profile.dart';
import '../../domain/driver_state.dart';
import 'ride_chat_panel.dart';

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
        decoration: const BoxDecoration(
          color: AppColors.charcoal,
          borderRadius: BorderRadius.only(
            topLeft: Radius.circular(28),
            topRight: Radius.circular(28),
          ),
          boxShadow: [
            BoxShadow(color: Color(0x44000000), blurRadius: 24, offset: Offset(0, -4)),
          ],
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // Drag handle
            const _SheetHandle(),
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 4, 24, 28),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _buildStatusBadge(),
                  const SizedBox(height: 8),
                  Text(
                    state.tripStep == TripStep.started
                        ? state.activeRequest!.destinationAddress
                        : state.activeRequest!.pickupAddress,
                    style: AppTextStyles.title(color: AppColors.white),
                    textAlign: TextAlign.center,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: 20),
                  if (state.tripStep != TripStep.completed)
                    _buildMainAction(context, ref),
                  if (state.tripStep == TripStep.completed)
                    _buildCompletionPanel(ref),
                  const SizedBox(height: 16),
                  _buildPassengerRow(context),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildStatusBadge() {
    String label;
    Color bg;
    Color fg;

    switch (state.tripStep) {
      case TripStep.accepted:
        label = 'Navigating to Pickup';
        bg = const Color(0xFF1E3A5F);
        fg = const Color(0xFF93C5FD);
        break;
      case TripStep.arrived:
        label = 'Waiting at Pickup';
        bg = AppColors.primaryLight;
        fg = AppColors.primaryDark;
        break;
      case TripStep.started:
        label = 'On Trip';
        bg = const Color(0xFF064E3B);
        fg = const Color(0xFF6EE7B7);
        break;
      case TripStep.completed:
        label = 'Trip Completed';
        bg = const Color(0xFF064E3B);
        fg = const Color(0xFF6EE7B7);
        break;
      default:
        return const SizedBox.shrink();
    }

    return Align(
      alignment: Alignment.center,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(20),
        ),
        child: Text(
          label,
          style: AppTextStyles.caption(color: fg, weight: FontWeight.w700),
        ),
      ),
    );
  }

  Widget _buildMainAction(BuildContext context, WidgetRef ref) {
    String text;
    Color bgColor;
    Color fgColor;
    VoidCallback? onPressed;

    switch (state.tripStep) {
      case TripStep.accepted:
        text = 'I Have Arrived';
        bgColor = AppColors.primary;
        fgColor = AppColors.charcoal;
        onPressed = () => ref.read(driverControllerProvider.notifier).markArrived();
        break;
      case TripStep.arrived:
        text = 'Start Trip';
        bgColor = AppColors.primary;
        fgColor = AppColors.charcoal;
        onPressed = () => ref.read(driverControllerProvider.notifier).startTrip();
        break;
      case TripStep.started:
        text = 'End Trip';
        bgColor = AppColors.error;
        fgColor = AppColors.white;
        onPressed = () {
          if (state.activeRequest!.isCash) {
            _showCashConfirmDialog(context, ref);
          } else {
            ref.read(driverControllerProvider.notifier).completeTrip();
          }
        };
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
      child: Text(text, style: AppTextStyles.body(color: fgColor, weight: FontWeight.w700)),
    );
  }

  Widget _buildCompletionPanel(WidgetRef ref) {
    final isCash = state.activeRequest?.isCash ?? false;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: const Color(0xFF064E3B),
            borderRadius: BorderRadius.circular(14),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(Icons.check_circle_outline, color: Color(0xFF6EE7B7), size: 20),
              const SizedBox(width: 10),
              Text(
                isCash ? 'Cash received — trip complete' : 'Fare captured successfully',
                style: AppTextStyles.body(color: const Color(0xFF6EE7B7), weight: FontWeight.w600),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        ElevatedButton(
          style: ElevatedButton.styleFrom(
            backgroundColor: AppColors.white,
            foregroundColor: AppColors.charcoal,
            padding: const EdgeInsets.symmetric(vertical: 16),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
            elevation: 0,
          ),
          onPressed: () => ref.read(driverControllerProvider.notifier).finishAndGoAvailable(),
          child: Text('Back to Available', style: AppTextStyles.body(weight: FontWeight.w700)),
        ),
      ],
    );
  }

  Widget _buildPassengerRow(BuildContext context) {
    final unread = state.chatMessages.where((m) => m.isPassenger).length;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: AppColors.darkGray,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        children: [
          Container(
            width: 40,
            height: 40,
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
              style: AppTextStyles.body(color: AppColors.white, weight: FontWeight.w600),
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
                  builder: (_) => SizedBox(
                    height: MediaQuery.of(context).size.height * 0.6,
                    child: const RideChatPanel(),
                  ),
                ),
              ),
              if (unread > 0)
                Positioned(
                  right: 0,
                  top: 0,
                  child: Container(
                    width: 16,
                    height: 16,
                    decoration: const BoxDecoration(
                      color: AppColors.error,
                      shape: BoxShape.circle,
                    ),
                    child: Center(
                      child: Text(
                        '$unread',
                        style: const TextStyle(color: AppColors.white, fontSize: 10, fontWeight: FontWeight.w700),
                      ),
                    ),
                  ),
                ),
            ],
          ),
          const SizedBox(width: 10),
          // Call
          _ActionCircle(
            icon: Icons.phone_outlined,
            color: AppColors.success,
            onTap: () async {
              final phone = state.activeRequest?.passengerPhone;
              if (phone != null && phone.isNotEmpty) {
                final uri = Uri(scheme: 'tel', path: phone);
                if (await canLaunchUrl(uri)) await launchUrl(uri);
              }
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
        title: Text(
          'Confirm Cash Received',
          style: AppTextStyles.title(color: AppColors.white),
        ),
        content: Text(
          'Did you physically collect ₦${fare.toStringAsFixed(0)} in cash from the passenger?',
          style: AppTextStyles.body(color: AppColors.lightGray),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: Text(
              'No — Go Back',
              style: AppTextStyles.body(color: AppColors.error),
            ),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: AppColors.success,
              foregroundColor: AppColors.white,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            ),
            onPressed: () {
              Navigator.pop(ctx);
              ref.read(driverControllerProvider.notifier).completeTrip();
            },
            child: Text('Yes — Confirm', style: AppTextStyles.body(color: AppColors.white, weight: FontWeight.w700)),
          ),
        ],
      ),
    );
  }
}

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

  const _ActionCircle({required this.icon, required this.color, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 40,
        height: 40,
        decoration: BoxDecoration(
          color: color.withOpacity(0.15),
          shape: BoxShape.circle,
        ),
        child: Icon(icon, color: color, size: 20),
      ),
    );
  }
}
