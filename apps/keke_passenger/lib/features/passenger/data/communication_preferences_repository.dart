import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/network/api_client.dart';

/// What a passenger has agreed to receive.
///
/// [hasBeenAsked] is the field that matters most: it distinguishes "said no"
/// from "never asked". Without it the app could not tell whether to show the
/// one-time prompt, and would either nag somebody who declined or never ask
/// anyone at all.
class CommunicationPreferences {
  const CommunicationPreferences({
    required this.marketing,
    required this.promotionalOffers,
    required this.productUpdates,
    required this.safetyAnnouncements,
    required this.hasBeenAsked,
  });

  final bool marketing;
  final bool promotionalOffers;
  final bool productUpdates;
  final bool safetyAnnouncements;
  final bool hasBeenAsked;

  /// Everything off except safety notices — what a passenger who has never been
  /// asked receives. Also the fallback when the request fails, because assuming
  /// consent on a network error is exactly the wrong direction to guess in.
  static const CommunicationPreferences unknown = CommunicationPreferences(
    marketing: false,
    promotionalOffers: false,
    productUpdates: false,
    safetyAnnouncements: true,
    hasBeenAsked: false,
  );

  factory CommunicationPreferences.fromJson(Map<String, dynamic> json) {
    bool read(String key, {bool fallback = false}) =>
        json[key] is bool ? json[key] as bool : fallback;

    return CommunicationPreferences(
      marketing: read('marketing'),
      promotionalOffers: read('promotionalOffers'),
      productUpdates: read('productUpdates'),
      safetyAnnouncements: read('safetyAnnouncements', fallback: true),
      hasBeenAsked: read('hasBeenAsked'),
    );
  }

  CommunicationPreferences copyWith({
    bool? marketing,
    bool? promotionalOffers,
    bool? productUpdates,
    bool? safetyAnnouncements,
    bool? hasBeenAsked,
  }) =>
      CommunicationPreferences(
        marketing: marketing ?? this.marketing,
        promotionalOffers: promotionalOffers ?? this.promotionalOffers,
        productUpdates: productUpdates ?? this.productUpdates,
        safetyAnnouncements: safetyAnnouncements ?? this.safetyAnnouncements,
        hasBeenAsked: hasBeenAsked ?? this.hasBeenAsked,
      );
}

class CommunicationPreferencesRepository {
  CommunicationPreferencesRepository(this._apiClient);

  final ApiClient _apiClient;

  /// Never throws.
  ///
  /// This is read on a settings screen and behind a prompt; neither is worth
  /// showing an error for. A failure returns [CommunicationPreferences.unknown],
  /// which is the safe direction — it can only ever under-report consent.
  Future<CommunicationPreferences> fetch() async {
    try {
      final response = await _apiClient.dio.get('/auth/me/communication-preferences');
      return CommunicationPreferences.fromJson(
          Map<String, dynamic>.from(response.data as Map));
    } on DioException {
      return CommunicationPreferences.unknown;
    } catch (_) {
      return CommunicationPreferences.unknown;
    }
  }

  /// [source] records which screen the passenger used. Stored server-side,
  /// because "they opted in" is only a defence if we can say how.
  Future<CommunicationPreferences> save({
    required bool promotionalOffers,
    required bool productUpdates,
    bool? safetyAnnouncements,
    String source = 'profile',
  }) async {
    final response = await _apiClient.dio.put(
      '/auth/me/communication-preferences',
      data: {
        'promotionalOffers': promotionalOffers,
        'productUpdates': productUpdates,
        if (safetyAnnouncements != null) 'safetyAnnouncements': safetyAnnouncements,
        'source': source,
      },
    );
    return CommunicationPreferences.fromJson(
        Map<String, dynamic>.from(response.data as Map));
  }

  /// Record that the passenger saw the one-time prompt and said no.
  ///
  /// Writes a row with everything false, so "no row" stops meaning both "never
  /// asked" and "asked and declined" — otherwise the prompt would reappear on
  /// every launch for somebody who already refused.
  Future<void> decline() async {
    try {
      await _apiClient.dio.post('/auth/me/communication-preferences/decline');
    } on DioException {
      // If this fails the prompt may appear once more. Harmless, and better
      // than blocking the passenger behind a dialog they already dismissed.
    }
  }
}

final communicationPreferencesRepositoryProvider =
    Provider<CommunicationPreferencesRepository>((ref) {
  return CommunicationPreferencesRepository(ref.watch(apiClientProvider));
});
