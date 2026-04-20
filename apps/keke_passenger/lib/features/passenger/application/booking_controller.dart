import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import '../domain/booking_state.dart';
import '../data/map_repository.dart';
import '../../../core/network/socket_service.dart';
import '../../../core/network/socket_provider.dart';
import '../../auth/application/auth_controller.dart';
import '../../auth/domain/auth_state.dart';
import 'package:jwt_decoder/jwt_decoder.dart';

class BookingController extends StateNotifier<BookingState> {
  final MapRepository _mapRepo;
  final SocketService? _socketService;
  final String passengerId;
  final String firstName;
  final String lastName;

  Timer? _debounceTimer;
  StreamSubscription? _socketSubscription;

  BookingController(this._mapRepo, this._socketService, this.passengerId, this.firstName, this.lastName) : super(const BookingState()) {
    _initializeMap();
    _listenToSocket();
  }

  void _listenToSocket() {
    if (_socketService == null) return;
    _socketSubscription = _socketService!.events.listen((data) {
      final event = data['event'];
      
      switch (event) {
        case 'ride:searching':
          state = state.copyWith(step: BookingStep.searching);
          break;
        case 'ride:assigned':
          state = state.copyWith(
            step: BookingStep.confirmed,
            assignedDriver: data['driverDetails'],
          );
          break;
        case 'ride:status_update':
           // Handle driver arrived, trip started, etc.
           break;
        case 'ride:failed':
          state = state.copyWith(
            step: BookingStep.previewEstimate,
            errorMessage: data['message'] ?? 'No drivers found.',
          );
          break;
      }
    });
  }

  Future<void> _initializeMap() async {
    final defaultLocation = const LatLng(6.1264, 6.7876); // Awka fallback
    final userLocation = await _mapRepo.getCurrentLocation();
    final center = userLocation ?? defaultLocation;

    state = state.copyWith(
      step: BookingStep.selectingPickup,
      mapCenter: center,
      pickupLocation: center,
      pickupAddress: 'Locating...',
    );
    _triggerReverseGeocode(center, isPickup: true);
  }

  void onCameraMove(CameraPosition position) {
    if (state.step != BookingStep.selectingPickup && state.step != BookingStep.idle) return;

    state = state.copyWith(
      isCameraMoving: true,
      mapCenter: position.target,
    );
    _debounceTimer?.cancel();
  }

  void onCameraIdle() {
    if (state.step != BookingStep.selectingPickup) return;
    
    state = state.copyWith(isCameraMoving: false);
    final target = state.mapCenter;
    if (target != null) {
      _debounceTimer?.cancel();
      _debounceTimer = Timer(const Duration(milliseconds: 400), () {
        _triggerReverseGeocode(target, isPickup: true);
      });
    }
  }

  Future<void> _triggerReverseGeocode(LatLng target, {required bool isPickup}) async {
    if (isPickup) {
      state = state.copyWith(pickupLocation: target, pickupAddress: 'Loading address...');
    }
    
    final address = await _mapRepo.reverseGeocode(target);
    
    if (isPickup && state.step == BookingStep.selectingPickup) {
      state = state.copyWith(pickupAddress: address);
    }
  }

  void confirmPickup() {
    if (state.pickupLocation == null) return;
    state = state.copyWith(step: BookingStep.selectingDestination);
  }

  void retreatToPickup() {
    state = state.copyWith(
      step: BookingStep.selectingPickup,
      destinationLocation: null,
      destinationAddress: null,
    );
  }

  void setPickup(String address, LatLng location) {
    state = state.copyWith(
      pickupAddress: address,
      pickupLocation: location,
    );
    if (state.destinationLocation != null) _calculateFare();
  }

  void setDestination(String address, LatLng location) {
    state = state.copyWith(
      destinationAddress: address,
      destinationLocation: location,
      step: BookingStep.confirming,
    );
    if (state.pickupLocation != null) _calculateFare();
  }

  void setPaymentMethod(String method) {
    state = state.copyWith(paymentMethod: method);
  }

  Future<void> _calculateFare() async {
    state = state.copyWith(isLoading: true, errorMessage: null);
    
    try {
      final estimate = await _mapRepo.calculateRouteAndFare(state.pickupLocation!, state.destinationLocation!);
      state = state.copyWith(
        estimatedDistance: estimate['distance'] as String,
        estimatedTime: estimate['time'] as String,
        estimatedFareAmount: estimate['fare'] as int,
        activeRoutePolyline: List<LatLng>.from(estimate['polyline']),
        isLoading: false,
      );
    } catch (e) {
      state = state.copyWith(errorMessage: 'Failed to calculate fare.', isLoading: false);
    }
  }

  void requestRide() {
    if (_socketService == null || state.pickupLocation == null || state.destinationLocation == null) return;

    final rideId = 'RIDE-${DateTime.now().millisecondsSinceEpoch}';
    
    _socketService!.emit('ride:request', {
      'rideId': rideId,
      'passengerId': passengerId,
      'isCash': state.paymentMethod == 'cash',
      'passengerName': '$firstName $lastName'.trim(), 
      'pickupAddress': state.pickupAddress,
      'pickupLat': state.pickupLocation!.latitude,
      'pickupLng': state.pickupLocation!.longitude,
      'destinationAddress': state.destinationAddress,
      'destinationLat': state.destinationLocation!.latitude,
      'destinationLng': state.destinationLocation!.longitude,
      'fare': state.estimatedFareAmount,
    });
    
    state = state.copyWith(step: BookingStep.searching);
  }
  
  void cancelBooking() {
    state = state.copyWith(
      step: BookingStep.selectingPickup,
      destinationAddress: null,
      destinationLocation: null,
      estimatedDistance: null,
      estimatedFareAmount: null,
      estimatedTime: null,
      activeRoutePolyline: [],
      assignedDriver: null,
    );
  }

  @override
  void dispose() {
    _debounceTimer?.cancel();
    _socketSubscription?.cancel();
    super.dispose();
  }
}

final bookingControllerProvider = StateNotifierProvider<BookingController, BookingState>((ref) {
  final socketService = ref.watch(socketServiceProvider);
  final authState = ref.watch(authControllerProvider);
  final mapRepo = ref.watch(mapRepositoryProvider);
  
  String passId = 'unknown';
  String fname = 'Passenger';
  String lname = '';
  
  if (authState.status == AuthStatus.authenticated && authState.token != null) {
      try {
        final decoded = JwtDecoder.decode(authState.token!);
        passId = decoded['userId'] as String? ?? 'unknown';
        fname = decoded['firstName'] as String? ?? 'Passenger';
        lname = decoded['lastName'] as String? ?? '';
      } catch (_) {}
  }
  
  return BookingController(mapRepo, socketService, passId, fname, lname);
});
