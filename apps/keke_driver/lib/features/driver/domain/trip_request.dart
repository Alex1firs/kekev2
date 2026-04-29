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
  });

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
    );
  }
}
