import 'driver_profile.dart';
import 'trip_request.dart';

class DriverState {
  final DriverProfile profile;
  final OperationStatus operationStatus;
  final TripStep tripStep;
  final TripRequest? activeRequest;
  final int? countdown;
  final bool isLoading;
  final String? errorMessage;

  const DriverState({
    required this.profile,
    this.operationStatus = OperationStatus.offline,
    this.tripStep = TripStep.none,
    this.activeRequest,
    this.countdown,
    this.isLoading = false,
    this.errorMessage,
  });

  DriverState copyWith({
    DriverProfile? profile,
    OperationStatus? operationStatus,
    TripStep? tripStep,
    TripRequest? activeRequest,
    int? countdown,
    bool? isLoading,
    String? errorMessage,
  }) {
    return DriverState(
      profile: profile ?? this.profile,
      operationStatus: operationStatus ?? this.operationStatus,
      tripStep: tripStep ?? this.tripStep,
      activeRequest: activeRequest ?? this.activeRequest,
      countdown: countdown ?? this.countdown,
      isLoading: isLoading ?? this.isLoading,
      errorMessage: errorMessage ?? this.errorMessage,
    );
  }
}
