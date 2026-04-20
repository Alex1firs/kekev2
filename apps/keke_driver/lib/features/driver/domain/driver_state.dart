import 'driver_profile.dart';
import 'trip_request.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';

class DriverState {
  final DriverProfile profile;
  final OperationStatus operationStatus;
  final TripStep tripStep;
  final TripRequest? activeRequest;
  final int? countdown;
  final bool isLoading;
  final String? errorMessage;
  final LatLng? mockLocation;

  const DriverState({
    required this.profile,
    this.operationStatus = OperationStatus.offline,
    this.tripStep = TripStep.none,
    this.activeRequest,
    this.countdown,
    this.isLoading = false,
    this.errorMessage,
    this.mockLocation,
  });

  DriverState copyWith({
    DriverProfile? profile,
    OperationStatus? operationStatus,
    TripStep? tripStep,
    TripRequest? activeRequest,
    int? countdown,
    bool? isLoading,
    String? errorMessage,
    LatLng? mockLocation,
    bool clearMockLocation = false,
  }) {
    return DriverState(
      profile: profile ?? this.profile,
      operationStatus: operationStatus ?? this.operationStatus,
      tripStep: tripStep ?? this.tripStep,
      activeRequest: activeRequest ?? this.activeRequest,
      countdown: countdown ?? this.countdown,
      isLoading: isLoading ?? this.isLoading,
      errorMessage: errorMessage ?? this.errorMessage,
      mockLocation: clearMockLocation ? null : (mockLocation ?? this.mockLocation),
    );
  }
}
