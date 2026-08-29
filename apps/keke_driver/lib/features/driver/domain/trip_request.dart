import 'package:google_maps_flutter/google_maps_flutter.dart';

class TripRequest {
  final String id;
  final String passengerId;
  final bool isCash;
  final String passengerName;
  final String? passengerPhone;
  final String pickupAddress;
  final LatLng pickupLocation;
  final String destinationAddress;
  final LatLng destinationLocation;
  final double fare;
  final double distance;
  final int countdownSeconds;
  final String? pickupCode;

  const TripRequest({
    required this.id,
    required this.passengerId,
    required this.isCash,
    required this.passengerName,
    this.passengerPhone,
    required this.pickupAddress,
    required this.pickupLocation,
    required this.destinationAddress,
    required this.destinationLocation,
    required this.fare,
    required this.distance,
    this.countdownSeconds = 30,
    this.pickupCode,
  });

  /// A copy with fields replaced. Added for the one field that legitimately
  /// arrives after the ride does: the passenger's number, which a manually
  /// assigned ride has to fetch from the server rather than read off an offer.
  TripRequest copyWith({
    String? passengerName,
    String? passengerPhone,
    int? countdownSeconds,
    String? pickupCode,
  }) {
    return TripRequest(
      id: id,
      passengerId: passengerId,
      isCash: isCash,
      passengerName: passengerName ?? this.passengerName,
      passengerPhone: passengerPhone ?? this.passengerPhone,
      pickupAddress: pickupAddress,
      pickupLocation: pickupLocation,
      destinationAddress: destinationAddress,
      destinationLocation: destinationLocation,
      fare: fare,
      distance: distance,
      countdownSeconds: countdownSeconds ?? this.countdownSeconds,
      pickupCode: pickupCode ?? this.pickupCode,
    );
  }

  factory TripRequest.fromJson(Map<String, dynamic> json, {required LatLng pickupLocation, required LatLng destinationLocation}) {
    return TripRequest(
      id: json['id']?.toString() ?? '',
      passengerId: json['passengerId']?.toString() ?? '',
      isCash: json['isCash'] as bool? ?? true,
      passengerName: json['passengerName']?.toString() ?? '',
      passengerPhone: json['passengerPhone']?.toString(),
      pickupAddress: json['pickupAddress']?.toString() ?? '',
      pickupLocation: pickupLocation,
      destinationAddress: json['destinationAddress']?.toString() ?? '',
      destinationLocation: destinationLocation,
      fare: double.tryParse(json['fare']?.toString() ?? '0') ?? 0,
      distance: double.tryParse(json['distance']?.toString() ?? '0') ?? 0,
      countdownSeconds: json['countdownSeconds'] as int? ?? 30,
      pickupCode: json['pickupCode']?.toString(),
    );
  }
}

/// What happened when the app asked for the passenger's number.
///
/// Distinguished rather than collapsed into null, because the four cases need
/// four different sentences. "We could not reach the server" and "this
/// passenger has no number on file" are not the same problem, and a driver
/// standing at a pickup point deserves to be told which one they have.
enum PassengerContactOutcome {
  /// A dialable number.
  ok,

  /// The ride is genuinely ours, but the passenger has no number on file.
  noNumber,

  /// The server says this ride is not ours — released, reassigned, or over.
  notAllowed,

  /// Nothing on screen to call about.
  noRide,

  /// Could not ask. Says nothing about whether a number exists.
  failed,
}

class PassengerContactResult {
  const PassengerContactResult(this.outcome, [this.phone]);
  const PassengerContactResult.ok(String number)
      : outcome = PassengerContactOutcome.ok,
        phone = number;

  final PassengerContactOutcome outcome;
  final String? phone;

  bool get dialable =>
      outcome == PassengerContactOutcome.ok && (phone?.isNotEmpty ?? false);

  /// What to tell the driver when there is nothing to dial.
  String get message {
    switch (outcome) {
      case PassengerContactOutcome.noNumber:
        return 'This passenger has no phone number on file. Use in-app chat.';
      case PassengerContactOutcome.notAllowed:
        return 'You are no longer assigned to this ride.';
      case PassengerContactOutcome.noRide:
        return 'No active ride to call about.';
      case PassengerContactOutcome.failed:
        return 'Could not get the number. Check your connection and try again.';
      case PassengerContactOutcome.ok:
        return '';
    }
  }
}
