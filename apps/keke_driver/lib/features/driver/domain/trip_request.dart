import 'package:google_maps_flutter/google_maps_flutter.dart';

  final String passengerId;
  final bool isCash;
  final String passengerName;
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
    required this.pickupAddress,
    required this.pickupLocation,
    required this.destinationAddress,
    required this.destinationLocation,
    required this.fare,
    required this.distance,
    this.countdownSeconds = 30,
  });
}
