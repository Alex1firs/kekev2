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
    this.marketingEmail = false,
    this.marketingPush = false,
    this.marketingInApp = false,
    this.marketingSms = false,
  });

  final bool marketing;
  final bool promotionalOffers;
  final bool productUpdates;
  final bool safetyAnnouncements;
  final bool hasBeenAsked;

  /// Per channel, because they are separate decisions. A passenger may take a
  /// push notification happily and want no email; SMS is a stronger imposition
  /// than either and is never granted by a general yes.
  final bool marketingEmail;
  final bool marketingPush;
  final bool marketingInApp;
  final bool marketingSms;

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
      marketingEmail: read('marketingEmail'),
      marketingPush: read('marketingPush'),
      marketingInApp: read('marketingInApp'),
      marketingSms: read('marketingSms'),
    );
  }

  CommunicationPreferences copyWith({
    bool? marketing,
    bool? promotionalOffers,
    bool? productUpdates,
    bool? safetyAnnouncements,
    bool? hasBeenAsked,
    bool? marketingEmail,
    bool? marketingPush,
    bool? marketingInApp,
    bool? marketingSms,
  }) =>
      CommunicationPreferences(
        marketing: marketing ?? this.marketing,
        promotionalOffers: promotionalOffers ?? this.promotionalOffers,
        productUpdates: productUpdates ?? this.productUpdates,
        safetyAnnouncements: safetyAnnouncements ?? this.safetyAnnouncements,
        hasBeenAsked: hasBeenAsked ?? this.hasBeenAsked,
        marketingEmail: marketingEmail ?? this.marketingEmail,
        marketingPush: marketingPush ?? this.marketingPush,
        marketingInApp: marketingInApp ?? this.marketingInApp,
        marketingSms: marketingSms ?? this.marketingSms,
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
    bool? promotionalOffers,
    bool? productUpdates,
    bool? safetyAnnouncements,
    bool? marketingEmail,
    bool? marketingPush,
    bool? marketingInApp,
    bool? marketingSms,
    String source = 'profile',
    String? appVersion,
  }) async {
    final response = await _apiClient.dio.put(
      '/auth/me/communication-preferences',
      data: {
        if (promotionalOffers != null) 'promotionalOffers': promotionalOffers,
        if (productUpdates != null) 'productUpdates': productUpdates,
        if (safetyAnnouncements != null) 'safetyAnnouncements': safetyAnnouncements,
        if (marketingEmail != null) 'marketingEmail': marketingEmail,
        if (marketingPush != null) 'marketingPush': marketingPush,
        if (marketingInApp != null) 'marketingInApp': marketingInApp,
        if (marketingSms != null) 'marketingSms': marketingSms,
        'source': source,
        if (appVersion != null) 'appVersion': appVersion,
      },
    );
    return CommunicationPreferences.fromJson(
        Map<String, dynamic>.from(response.data as Map));
  }

  /// Whether the server thinks this passenger should be shown the prompt.
  ///
  /// The decision is the server's so a reinstall cannot reset it. Any failure
  /// returns false: not asking is always the safe outcome.
  Future<bool> shouldShowPrompt() async {
    try {
      final response = await _apiClient.dio.get('/auth/me/communication-prompt');
      final data = Map<String, dynamic>.from(response.data as Map);
      return data['show'] == true;
    } catch (_) {
      return false;
    }
  }

  /// Count the ask. Recorded before display, so force-quitting the app while it
  /// is on screen cannot produce an infinite loop of prompts.
  Future<void> recordPromptShown() async {
    try {
      await _apiClient.dio.post('/auth/me/communication-prompt/shown');
    } catch (_) {
      // A missed count means at most one extra ask. Not worth surfacing.
    }
  }

  /// The passenger answered. Either way the prompt is finished for good.
  Future<void> answerPrompt({required bool accepted, String? appVersion}) async {
    try {
      await _apiClient.dio.post('/auth/me/communication-prompt/answer', data: {
        'accepted': accepted,
        // SMS is deliberately absent: a general yes never grants it.
        if (appVersion != null) 'appVersion': appVersion,
      });
    } catch (_) {
      // The prompt closes regardless. Pressing it again later is harmless.
    }
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
