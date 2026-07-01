import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../../core/theme/app_theme.dart';
import '../../application/booking_controller.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';

class SosSheet extends ConsumerStatefulWidget {
  const SosSheet({super.key});

  static void show(BuildContext context) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => const SosSheet(),
    );
  }

  @override
  ConsumerState<SosSheet> createState() => _SosSheetState();
}

class _SosSheetState extends ConsumerState<SosSheet> {
  double _slideValue = 0.0;
  bool _triggered = false;
  String? _selectedReason;

  final List<String> _reasons = [
    'Medical Emergency',
    'Accident',
    'Unsafe Driver',
    'Robbery / Threat',
    'Vehicle Breakdown',
    'Other'
  ];

  void _triggerSos() {
    if (_triggered) return;
    setState(() => _triggered = true);

    final reason = _selectedReason ?? 'Emergency';
    ref.read(bookingControllerProvider.notifier).triggerSos(reason);

    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('SOS Alert sent to admin. Help is on the way.'),
        backgroundColor: AppColors.error,
      ),
    );
    Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        color: AppColors.white,
        borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
      ),
      padding: EdgeInsets.fromLTRB(20, 12, 20, MediaQuery.of(context).padding.bottom + 20),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Center(
            child: Container(
              width: 40,
              height: 4,
              decoration: BoxDecoration(
                color: AppColors.border,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ),
          const SizedBox(height: 20),
          Row(
            children: [
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: AppColors.errorLight,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: const Icon(Icons.emergency_share_rounded, color: AppColors.error, size: 28),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Emergency SOS', style: AppTextStyles.headline(color: AppColors.error)),
                    const SizedBox(height: 2),
                    Text('Slide to alert admin immediately.',
                        style: AppTextStyles.bodySmall(color: AppColors.charcoal)),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 24),
          Text('What is the emergency?', style: AppTextStyles.label(color: AppColors.midGray, weight: FontWeight.w700)),
          const SizedBox(height: 12),
          Wrap(
            spacing: 10,
            runSpacing: 10,
            children: _reasons.map((reason) {
              final isSelected = _selectedReason == reason;
              return GestureDetector(
                onTap: () => setState(() => _selectedReason = reason),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                  decoration: BoxDecoration(
                    color: isSelected ? AppColors.error : AppColors.paleGray,
                    borderRadius: BorderRadius.circular(20),
                    border: Border.all(color: isSelected ? AppColors.error : AppColors.border),
                  ),
                  child: Text(
                    reason,
                    style: AppTextStyles.bodySmall(
                      color: isSelected ? Colors.white : AppColors.charcoal,
                      weight: isSelected ? FontWeight.w700 : FontWeight.w500,
                    ),
                  ),
                ),
              );
            }).toList(),
          ),
          const SizedBox(height: 32),
          // Slide to SOS Button
          Container(
            height: 60,
            decoration: BoxDecoration(
              color: AppColors.errorLight,
              borderRadius: BorderRadius.circular(30),
            ),
            child: Stack(
              children: [
                Center(
                  child: Text(
                    'Slide to send SOS',
                    style: AppTextStyles.button(color: AppColors.error),
                  ),
                ),
                Positioned(
                  left: 0,
                  top: 0,
                  bottom: 0,
                  child: GestureDetector(
                    onHorizontalDragUpdate: (details) {
                      if (_triggered) return;
                      setState(() {
                        // Max width is context width - 40 (padding) - 60 (button width)
                        final maxWidth = MediaQuery.of(context).size.width - 40 - 60;
                        _slideValue += details.delta.dx;
                        if (_slideValue < 0) _slideValue = 0;
                        if (_slideValue > maxWidth) {
                          _slideValue = maxWidth;
                          _triggerSos();
                        }
                      });
                    },
                    onHorizontalDragEnd: (details) {
                      if (!_triggered) {
                        setState(() => _slideValue = 0);
                      }
                    },
                    child: Transform.translate(
                      offset: Offset(_slideValue, 0),
                      child: Container(
                        width: 60,
                        height: 60,
                        decoration: BoxDecoration(
                          color: AppColors.error,
                          shape: BoxShape.circle,
                          boxShadow: [
                            BoxShadow(
                              color: AppColors.error.withOpacity(0.4),
                              blurRadius: 10,
                              offset: const Offset(0, 4),
                            ),
                          ],
                        ),
                        child: const Icon(Icons.arrow_forward_ios_rounded, color: Colors.white, size: 24),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
