import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'booking_notice.dart';
import 'chat_message.dart';
import 'nearby_keke.dart';
import 'ride_coordination.dart';

enum BookingStep {
  loading,
  idle,                 // Map moves freely, no intent yet or viewing area
  selectingPickup,      // Fixed pin active, reverse geocoding active
  selectingDestination, // Pickup locked, searching for destination
  selectingDestinationOnMap, // Manual map selection for destination
  previewEstimate,      // Both locked, showing polyline and fare
  searching,            // Backend is looking for driver
  confirmed,            // Driver accepted
  arrived,              // Driver arrived at pickup
  started,              // Trip has started
  completed,            // Trip finished — show receipt
}

class BookingState {
  final BookingStep step;
  
  final LatLng? mapCenter; 
  final bool isCameraMoving;

  final LatLng? pickupLocation;
  final String? pickupAddress;
  
  final LatLng? destinationLocation;
  final String? destinationAddress;

  final int? estimatedFareAmount;
  final String? estimatedDistance;
  final String? estimatedTime;
  
  final List<LatLng> activeRoutePolyline; // Explicit accurate paths

  final String? errorMessage;

  /// Structured outcome of the last ride request (no driver, expired, network
  /// failure, …). Carries its own copy and tone so the UI never has to guess
  /// whether a message is an availability notice or a real error.
  final BookingNotice? notice;

  /// Which dispatch round the current search is on (1-based). Round >= 2 shows
  /// the "Still searching nearby…" copy.
  final int searchRound;

  /// How many times the passenger has searched for this pickup/destination
  /// pair. Reported with the outcome event.
  final int searchAttempts;

  final Map<String, dynamic>? assignedDriver;
  final String paymentMethod;
  
  final String? rideId;
  final LatLng? assignedDriverLocation;
  final DateTime? lastLocationUpdate;
  final List<ChatMessage> chatMessages;
  final List<LatLng> nearbyDrivers;

  /// Anonymous, approximated nearby Kekes for the map while a request searches.
  /// Empty means genuinely no eligible supply — it is never padded.
  final NearbyKekeFeed nearbyKekes;

  // Live tracking fields — populated during confirmed/arrived states
  final String? pickupCode;
  final double? etaMinutes;
  final double? distanceToPickupMeters;
  final bool isDriverNearby;
  final List<LatLng> approachRoutePolyline; // driver→pickup road route
  final LatLng? lastApproachOrigin;         // driver pos when approach route was last fetched

  // On-trip navigation fields — populated during started state
  final double? etaToDestinationMinutes;
  final double? distanceToDestinationMeters;

  // Receipt data — populated when ride:finished arrives
  final String? receiptPickupAddress;
  final String? receiptDestinationAddress;
  final int? receiptFare;
  final String? receiptPaymentMethod;
  final Map<String, dynamic>? receiptDriver;
  final String? receiptDistance;
  final DateTime? receiptCompletedAt;

  /// The driver requested an early drop-off confirmation ("Did you get dropped
  /// off here?"). Drives the confirm/report dialog on the active-ride screen.
  final bool earlyEndRequested;

  /// The live delayed-ride / cancellation-decision state, or null when there is
  /// nothing to coordinate. Server-authoritative: the app renders it and reports
  /// the passenger's answer, and never decides on its own that a ride is late.
  final RideCoordination? coordination;

  /// How a ride that just ended was classified by the server, when it ended in a
  /// way the passenger needs explaining (nobody answered, the driver asked to
  /// cancel). Null for an ordinary completion.
  final RideClosure? closure;
  final String? closureTitle;
  final String? closureBody;

  /// Set to the just-completed ride's id when the trip finishes, so the receipt
  /// can prompt the passenger to rate the driver. Cleared once the passenger
  /// submits or skips the rating (so it never re-prompts for the same ride).
  final String? pendingReviewRideId;

  const BookingState({
    this.step = BookingStep.loading,
    this.mapCenter,
    this.isCameraMoving = false,
    this.pickupLocation,
    this.pickupAddress,
    this.destinationLocation,
    this.destinationAddress,
    this.estimatedFareAmount,
    this.estimatedDistance,
    this.estimatedTime,
    this.activeRoutePolyline = const [],
    this.assignedDriver,
    this.paymentMethod = 'cash',
    this.errorMessage,
    this.notice,
    this.searchRound = 1,
    this.searchAttempts = 0,
    this.rideId,
    this.assignedDriverLocation,
    this.lastLocationUpdate,
    this.chatMessages = const [],
    this.nearbyDrivers = const [],
    this.nearbyKekes = NearbyKekeFeed.empty,
    this.pickupCode,
    this.etaMinutes,
    this.distanceToPickupMeters,
    this.isDriverNearby = false,
    this.approachRoutePolyline = const [],
    this.lastApproachOrigin,
    this.etaToDestinationMinutes,
    this.distanceToDestinationMeters,
    this.receiptPickupAddress,
    this.receiptDestinationAddress,
    this.receiptFare,
    this.receiptPaymentMethod,
    this.receiptDriver,
    this.receiptDistance,
    this.receiptCompletedAt,
    this.earlyEndRequested = false,
    this.pendingReviewRideId,
    this.coordination,
    this.closure,
    this.closureTitle,
    this.closureBody,
  });

  BookingState copyWith({
    BookingStep? step,
    LatLng? mapCenter,
    bool? isCameraMoving,
    LatLng? pickupLocation,
    String? pickupAddress,
    LatLng? destinationLocation,
    String? destinationAddress,
    int? estimatedFareAmount,
    String? estimatedDistance,
    String? estimatedTime,
    List<LatLng>? activeRoutePolyline,
    Map<String, dynamic>? assignedDriver,
    String? paymentMethod,
    String? errorMessage,
    BookingNotice? notice,
    bool clearNotice = false,
    int? searchRound,
    int? searchAttempts,
    String? rideId,
    bool clearAssignedDriver = false,
    bool clearRideId = false,
    bool clearErrorMessage = false,
    LatLng? assignedDriverLocation,
    DateTime? lastLocationUpdate,
    List<ChatMessage>? chatMessages,
    List<LatLng>? nearbyDrivers,
    NearbyKekeFeed? nearbyKekes,
    bool clearNearbyKekes = false,
    String? pickupCode,
    bool clearPickupCode = false,
    double? etaMinutes,
    bool clearEta = false,
    double? distanceToPickupMeters,
    bool? isDriverNearby,
    List<LatLng>? approachRoutePolyline,
    bool clearApproachRoute = false,
    LatLng? lastApproachOrigin,
    bool clearLastApproachOrigin = false,
    double? etaToDestinationMinutes,
    bool clearDestinationEta = false,
    double? distanceToDestinationMeters,
    String? receiptPickupAddress,
    String? receiptDestinationAddress,
    int? receiptFare,
    String? receiptPaymentMethod,
    Map<String, dynamic>? receiptDriver,
    String? receiptDistance,
    DateTime? receiptCompletedAt,
    bool? earlyEndRequested,
    String? pendingReviewRideId,
    bool clearPendingReview = false,
    RideCoordination? coordination,
    bool clearCoordination = false,
    RideClosure? closure,
    String? closureTitle,
    String? closureBody,
    bool clearClosure = false,
  }) {
    return BookingState(
      step: step ?? this.step,
      mapCenter: mapCenter ?? this.mapCenter,
      isCameraMoving: isCameraMoving ?? this.isCameraMoving,
      pickupLocation: pickupLocation ?? this.pickupLocation,
      pickupAddress: pickupAddress ?? this.pickupAddress,
      destinationLocation: destinationLocation ?? this.destinationLocation,
      destinationAddress: destinationAddress ?? this.destinationAddress,
      estimatedFareAmount: estimatedFareAmount ?? this.estimatedFareAmount,
      estimatedDistance: estimatedDistance ?? this.estimatedDistance,
      estimatedTime: estimatedTime ?? this.estimatedTime,
      activeRoutePolyline: activeRoutePolyline ?? this.activeRoutePolyline,
      assignedDriver: clearAssignedDriver ? null : (assignedDriver ?? this.assignedDriver),
      paymentMethod: paymentMethod ?? this.paymentMethod,
      errorMessage: clearErrorMessage ? null : (errorMessage ?? this.errorMessage),
      notice: clearNotice ? null : (notice ?? this.notice),
      searchRound: searchRound ?? this.searchRound,
      searchAttempts: searchAttempts ?? this.searchAttempts,
      rideId: clearRideId ? null : (rideId ?? this.rideId),
      assignedDriverLocation: assignedDriverLocation ?? this.assignedDriverLocation,
      lastLocationUpdate: lastLocationUpdate ?? this.lastLocationUpdate,
      chatMessages: chatMessages ?? this.chatMessages,
      nearbyDrivers: nearbyDrivers ?? this.nearbyDrivers,
      nearbyKekes: clearNearbyKekes
          ? NearbyKekeFeed.empty
          : (nearbyKekes ?? this.nearbyKekes),
      pickupCode: clearPickupCode ? null : (pickupCode ?? this.pickupCode),
      etaMinutes: clearEta ? null : (etaMinutes ?? this.etaMinutes),
      distanceToPickupMeters: clearEta ? null : (distanceToPickupMeters ?? this.distanceToPickupMeters),
      isDriverNearby: isDriverNearby ?? this.isDriverNearby,
      approachRoutePolyline: clearApproachRoute ? [] : (approachRoutePolyline ?? this.approachRoutePolyline),
      lastApproachOrigin: clearLastApproachOrigin ? null : (lastApproachOrigin ?? this.lastApproachOrigin),
      etaToDestinationMinutes: clearDestinationEta ? null : (etaToDestinationMinutes ?? this.etaToDestinationMinutes),
      distanceToDestinationMeters: clearDestinationEta ? null : (distanceToDestinationMeters ?? this.distanceToDestinationMeters),
      receiptPickupAddress: receiptPickupAddress ?? this.receiptPickupAddress,
      receiptDestinationAddress: receiptDestinationAddress ?? this.receiptDestinationAddress,
      receiptFare: receiptFare ?? this.receiptFare,
      receiptPaymentMethod: receiptPaymentMethod ?? this.receiptPaymentMethod,
      receiptDriver: receiptDriver ?? this.receiptDriver,
      receiptDistance: receiptDistance ?? this.receiptDistance,
      receiptCompletedAt: receiptCompletedAt ?? this.receiptCompletedAt,
      earlyEndRequested: earlyEndRequested ?? this.earlyEndRequested,
      pendingReviewRideId: clearPendingReview ? null : (pendingReviewRideId ?? this.pendingReviewRideId),
      coordination: clearCoordination ? null : (coordination ?? this.coordination),
      closure: clearClosure ? null : (closure ?? this.closure),
      closureTitle: clearClosure ? null : (closureTitle ?? this.closureTitle),
      closureBody: clearClosure ? null : (closureBody ?? this.closureBody),
    );
  }
}

