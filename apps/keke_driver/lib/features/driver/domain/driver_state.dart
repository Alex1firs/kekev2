import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'driver_profile.dart';
import 'trip_request.dart';
import 'chat_message.dart';

class DriverState {
  final DriverProfile profile;
  final OperationStatus operationStatus;
  final TripStep tripStep;
  final TripRequest? activeRequest;
  final int? countdown;
  final bool isLoading;
  /// True once the driver's profile status has been confirmed by the server at
  /// least once. Until this is true we must NOT treat an `unregistered` status
  /// as "new driver" — the fetch may still be in flight or have failed, and
  /// misclassifying an onboarded driver here misroutes them to /onboarding.
  final bool profileLoaded;
  final String? errorMessage;
  final int waitTimeSeconds;
  final List<ChatMessage> chatMessages;

  // Navigation fields — populated during active trip steps
  final List<LatLng> pickupRoute;
  final List<LatLng> destinationRoute;
  final double? routeEtaMinutes;
  final double? routeDistanceMeters;

  // Driver's own live GPS position (updated every heartbeat)
  final LatLng? driverCurrentPosition;

  const DriverState({
    required this.profile,
    this.operationStatus = OperationStatus.offline,
    this.tripStep = TripStep.none,
    this.activeRequest,
    this.countdown,
    this.isLoading = false,
    this.profileLoaded = false,
    this.errorMessage,
    this.waitTimeSeconds = 0,
    this.chatMessages = const [],
    this.pickupRoute = const [],
    this.destinationRoute = const [],
    this.routeEtaMinutes,
    this.routeDistanceMeters,
    this.driverCurrentPosition,
  });

  DriverState copyWith({
    DriverProfile? profile,
    OperationStatus? operationStatus,
    TripStep? tripStep,
    TripRequest? activeRequest,
    int? countdown,
    bool? isLoading,
    bool? profileLoaded,
    String? errorMessage,
    bool clearActiveRequest = false,
    bool clearCountdown = false,
    bool clearErrorMessage = false,
    int? waitTimeSeconds,
    List<ChatMessage>? chatMessages,
    List<LatLng>? pickupRoute,
    bool clearPickupRoute = false,
    List<LatLng>? destinationRoute,
    bool clearDestinationRoute = false,
    double? routeEtaMinutes,
    bool clearRouteEta = false,
    double? routeDistanceMeters,
    LatLng? driverCurrentPosition,
    bool clearDriverPosition = false,
  }) {
    return DriverState(
      profile: profile ?? this.profile,
      operationStatus: operationStatus ?? this.operationStatus,
      tripStep: tripStep ?? this.tripStep,
      activeRequest: clearActiveRequest ? null : (activeRequest ?? this.activeRequest),
      countdown: clearCountdown ? null : (countdown ?? this.countdown),
      isLoading: isLoading ?? this.isLoading,
      profileLoaded: profileLoaded ?? this.profileLoaded,
      errorMessage: clearErrorMessage ? null : (errorMessage ?? this.errorMessage),
      waitTimeSeconds: waitTimeSeconds ?? this.waitTimeSeconds,
      chatMessages: chatMessages ?? this.chatMessages,
      pickupRoute: clearPickupRoute ? [] : (pickupRoute ?? this.pickupRoute),
      destinationRoute: clearDestinationRoute ? [] : (destinationRoute ?? this.destinationRoute),
      routeEtaMinutes: clearRouteEta ? null : (routeEtaMinutes ?? this.routeEtaMinutes),
      routeDistanceMeters: clearRouteEta ? null : (routeDistanceMeters ?? this.routeDistanceMeters),
      driverCurrentPosition: clearDriverPosition ? null : (driverCurrentPosition ?? this.driverCurrentPosition),
    );
  }
}
