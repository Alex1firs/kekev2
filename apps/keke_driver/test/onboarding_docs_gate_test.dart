import 'package:flutter_test/flutter_test.dart';
import 'package:keke_driver/features/driver/domain/driver_profile.dart';
import 'package:keke_driver/features/driver/presentation/onboarding_screen.dart';

/// These tests lock in the driver onboarding rule that the app must NOT advance
/// to "Document Under Review" until the driver has uploaded a selfie (photoUrl).
/// onboardingDocsBlockReason() is the single gate the submit button consults.
void main() {
  DriverProfile profile({
    String? license,
    String? idCard,
    String? vehicle,
    String? photo,
  }) =>
      DriverProfile(
        status: DriverStatus.pendingDocuments,
        licenseUrl: license,
        idCardUrl: idCard,
        vehiclePaperUrl: vehicle,
        photoUrl: photo,
      );

  group('onboardingDocsBlockReason', () {
    test('blocks submission when NO documents are uploaded', () {
      final reason = onboardingDocsBlockReason(profile());
      expect(reason, isNotNull);
      expect(reason, contains('selfie'));
    });

    test(
        'blocks with the SELFIE-SPECIFIC message when license/ID/vehicle are '
        'uploaded but the selfie is missing (the reported bug scenario)', () {
      final reason = onboardingDocsBlockReason(profile(
        license: 'license.jpg',
        idCard: 'id.jpg',
        vehicle: 'vehicle.jpg',
        photo: null, // selfie skipped
      ));
      expect(reason, 'Please take a selfie to complete your verification.');
    });

    test('still blocks when the selfie exists but another document is missing',
        () {
      final reason = onboardingDocsBlockReason(profile(
        license: 'license.jpg',
        idCard: 'id.jpg',
        vehicle: null,
        photo: 'selfie.jpg',
      ));
      expect(reason, isNotNull);
      expect(reason, isNot(contains('selfie')));
    });

    test('allows submission ONLY when all four docs incl. selfie are present',
        () {
      final reason = onboardingDocsBlockReason(profile(
        license: 'license.jpg',
        idCard: 'id.jpg',
        vehicle: 'vehicle.jpg',
        photo: 'selfie.jpg',
      ));
      expect(reason, isNull);
    });
  });
}
