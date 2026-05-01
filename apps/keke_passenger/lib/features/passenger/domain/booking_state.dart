import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'chat_message.dart';

enum BookingStep {
  loading,
  idle,                 // Map moves freely, no intent yet or viewing area
  selectingPickup,      // Fixed pin active, reverse geocoding active
  selectingDestination, // Pickup locked, searching for destination
  previewEstimate,      // Both locked, showing polyline and fare
  searching,            // Backend is looking for driver
  confirmed,            // Driver accepted
  arrived,              // Driver arrived at pickup
  started               // Trip has started
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
  final Map<String, dynamic>? assignedDriver;
  final String paymentMethod;
  
  final String? rideId;
  final LatLng? assignedDriverLocation;
  final DateTime? lastLocationUpdate;
  final List<ChatMessage> chatMessages;

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
    this.rideId,
    this.assignedDriverLocation,
    this.lastLocationUpdate,
    this.chatMessages = const [],
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
    String? rideId,
    bool clearAssignedDriver = false,
    bool clearRideId = false,
    LatLng? assignedDriverLocation,
    DateTime? lastLocationUpdate,
    List<ChatMessage>? chatMessages,
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
      errorMessage: errorMessage ?? this.errorMessage,
      rideId: clearRideId ? null : (rideId ?? this.rideId),
      assignedDriverLocation: assignedDriverLocation ?? this.assignedDriverLocation,
      lastLocationUpdate: lastLocationUpdate ?? this.lastLocationUpdate,
      chatMessages: chatMessages ?? this.chatMessages,
    );
  }
}

