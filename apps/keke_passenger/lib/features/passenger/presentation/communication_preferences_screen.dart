import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/theme/app_theme.dart';
import '../data/communication_preferences_repository.dart';

/// Where a passenger chooses what KekeRide sends them.
///
/// ── Why the essential-mail line is always on screen ──────────────────────
/// The commonest fear at a screen like this is that turning things off will
/// cost you something you need — a verification code, a password reset. Saying
/// plainly that those always arrive is what makes it safe to say no to the
/// rest, and a passenger who feels safe saying no is one who uses the toggle
/// instead of the spam button.
class CommunicationPreferencesScreen extends ConsumerStatefulWidget {
  const CommunicationPreferencesScreen({super.key});

  @override
  ConsumerState<CommunicationPreferencesScreen> createState() =>
      _CommunicationPreferencesScreenState();
}

class _CommunicationPreferencesScreenState
    extends ConsumerState<CommunicationPreferencesScreen> {
  CommunicationPreferences _prefs = CommunicationPreferences.unknown;
  bool _loading = true;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final prefs =
        await ref.read(communicationPreferencesRepositoryProvider).fetch();
    if (!mounted) return;
    setState(() {
      _prefs = prefs;
      _loading = false;
    });
  }

  /// Saves on every change rather than behind a Save button.
  ///
  /// A preference screen that needs confirming is one people leave without
  /// confirming, and the result is a passenger who believes they unsubscribed
  /// and did not.
  Future<void> _update({bool? offers, bool? updates, bool? safety}) async {
    final next = _prefs.copyWith(
      promotionalOffers: offers,
      productUpdates: updates,
      safetyAnnouncements: safety,
    );
    setState(() {
      _prefs = next;
      _saving = true;
    });

    try {
      final saved = await ref.read(communicationPreferencesRepositoryProvider).save(
            promotionalOffers: next.promotionalOffers,
            productUpdates: next.productUpdates,
            safetyAnnouncements: next.safetyAnnouncements,
          );
      if (!mounted) return;
      setState(() {
        _prefs = saved;
        _saving = false;
      });
    } catch (_) {
      if (!mounted) return;
      // Put the switch back where it was: a toggle that stays moved after a
      // failed save tells the passenger something untrue.
      setState(() {
        _prefs = _prefs.copyWith(
          promotionalOffers: offers != null ? !offers : null,
          productUpdates: updates != null ? !updates : null,
          safetyAnnouncements: safety != null ? !safety : null,
        );
        _saving = false;
      });
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Could not save that. Please try again.')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.charcoal,
      appBar: AppBar(
        backgroundColor: AppColors.charcoal,
        elevation: 0,
        title: const Text('Emails from KekeRide'),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
              children: [
                Text(
                  'Choose what you would like to hear about.',
                  style: AppTextStyles.bodySmall(color: AppColors.lightGray),
                ),
                const SizedBox(height: 20),

                _PreferenceTile(
                  title: 'Offers and promotions',
                  subtitle: 'Discounts and promo codes for your rides.',
                  value: _prefs.promotionalOffers,
                  enabled: !_saving,
                  onChanged: (v) => _update(offers: v),
                ),
                const Divider(color: AppColors.darkGray, height: 1),

                _PreferenceTile(
                  title: 'Product news',
                  subtitle: 'New features and service areas.',
                  value: _prefs.productUpdates,
                  enabled: !_saving,
                  onChanged: (v) => _update(updates: v),
                ),
                const Divider(color: AppColors.darkGray, height: 1),

                _PreferenceTile(
                  title: 'Safety and service notices',
                  subtitle:
                      'Things that affect your rides. We recommend leaving this on.',
                  value: _prefs.safetyAnnouncements,
                  enabled: !_saving,
                  onChanged: (v) => _update(safety: v),
                ),

                const SizedBox(height: 28),
                Container(
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    color: AppColors.darkGray.withValues(alpha: 0.35),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Icon(Icons.lock_outline,
                          size: 18, color: AppColors.lightGray),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Text(
                          'Essential emails about your account and your rides — '
                          'verification codes, password resets and receipts — are '
                          'always sent, whatever you choose here.',
                          style:
                              AppTextStyles.bodySmall(color: AppColors.lightGray),
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

class _PreferenceTile extends StatelessWidget {
  const _PreferenceTile({
    required this.title,
    required this.subtitle,
    required this.value,
    required this.onChanged,
    required this.enabled,
  });

  final String title;
  final String subtitle;
  final bool value;
  final ValueChanged<bool> onChanged;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    return SwitchListTile.adaptive(
      contentPadding: EdgeInsets.zero,
      value: value,
      onChanged: enabled ? onChanged : null,
      activeColor: AppColors.primary,
      title: Text(title, style: AppTextStyles.body(color: Colors.white)),
      subtitle: Padding(
        padding: const EdgeInsets.only(top: 4),
        child: Text(subtitle,
            style: AppTextStyles.bodySmall(color: AppColors.lightGray)),
      ),
    );
  }
}
