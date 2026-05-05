import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import '../domain/booking_state.dart';
import '../data/map_repository.dart';
import '../../../core/network/socket_service.dart';
import '../../../core/network/socket_provider.dart';
import '../../../core/network/api_client.dart';
import '../../auth/application/auth_controller.dart';
import '../../auth/domain/auth_state.dart';
import 'package:jwt_decoder/jwt_decoder.dart';
import '../../../core/network/notification_service.dart';
import '../domain/chat_message.dart';
import '../../../core/services/sound_service.dart';

class BookingController extends StateNotifier<BookingState> {
  final MapRepository _mapRepo;
  SocketService? _socketService;
  final ApiClient? _apiClient;
  final String passengerId;
  final String firstName;
  final String lastName;

  Timer? _debounceTimer;
  Timer? _watchdogTimer;
  StreamSubscription? _socketSubscription;
  StreamSubscription? _notificationSubscription;
  final NotificationService _notificationService;
  final SoundService _soundService;

  BookingController(this._mapRepo, SocketService? initialSocket, this._apiClient, this._notificationService, this._soundService, this.passengerId, this.firstName, this.lastName) : super(const BookingState()) {
    _socketService = initialSocket;
    _initializeMap();
    if (_socketService != null) _listenToSocket();
    _listenToNotifications();
  }

  void _listenToNotifications() {
    _notificationSubscription = _notificationService.intentStream.listen((data) {
      print('[PASSENGER_SYNC] Notification intent received: $data. Triggering sync...');
      syncStatus();
    });
    
    // Catch cold starts from a notification
    _notificationService.handleInitialMessage();
  }

  void updateSocketService(SocketService? newService) {
    if (newService == _socketService) return;
    
    print('[SOCKET_SYNC] Socket Service updated. Re-linking...');
    _socketSubscription?.cancel();
    _socketService = newService;
    
    if (_socketService != null) {
      _listenToSocket();
      
      // If we have an active ride, immediately re-join the room
      if (state.rideId != null) {
        print('[SOCKET_SYNC] Re-joining ride room on new socket: ${state.rideId}');
        _socketService!.emit('join', {'userId': state.rideId, 'role': 'ride'});
        
        // Redundant sync to catch any state drift during the gap
        syncStatus();
      }
    }
  }

  void _listenToSocket() {
    if (_socketService == null) return;
    _socketSubscription = _socketService!.events.listen((data) {
      final event = data['event'];
      print('[PASSENGER_SYNC] Event: $event | CurrentStep: ${state.step}');
      
      switch (event) {
        case 'ride:searching':
          state = state.copyWith(step: BookingStep.searching);
          _startWatchdog();
          break;
        case 'socket:reconnected':
          print('[PASSENGER_SYNC] Socket reconnected. Triggering redundant healing...');
          syncStatus();
          break;
        case 'ride:assigned':
          state = state.copyWith(
            step: BookingStep.confirmed,
            assignedDriver: data['driverDetails'],
          );
          _stopWatchdog();
          _soundService.playAlert(); // 🔔 Driver found
          break;
        case 'ride:status_update':
           print('[PASSENGER_SYNC] Status update: ${data['status']}');
           if (data['status'] == 'arrived') {
             state = state.copyWith(step: BookingStep.arrived);
             _soundService.playAlert(); // 🔔 Driver arrived
           } else if (data['status'] == 'started') {
             state = state.copyWith(step: BookingStep.started);
           }
           break;
        case 'chat:message':
          final msg = ChatMessage(
            senderId:   data['senderId'] as String,
            senderRole: data['senderRole'] as String,
            message:    data['message'] as String,
            timestamp:  DateTime.tryParse(data['timestamp'] as String? ?? '') ?? DateTime.now(),
          );
          state = state.copyWith(chatMessages: [...state.chatMessages, msg]);
          break;
        case 'ride:cancelled':
          print('[PASSENGER_SYNC] Ride cancelled. Resetting state.');
          _stopWatchdog();
          _resetBookingState();
          break;
        case 'ride:finished':
          print('[PASSENGER_SYNC] Ride finished. Showing receipt.');
          _stopWatchdog();
          _showReceipt();
          break;
        case 'ride:failed':
          state = state.copyWith(
            step: BookingStep.previewEstimate,
            errorMessage: data['message'] ?? 'No drivers found.',
          );
          break;
        case 'driver:location_update':
          state = state.copyWith(
            assignedDriverLocation: LatLng(
              double.parse(data['lat'].toString()),
              double.parse(data['lng'].toString()),
            ),
            lastLocationUpdate: DateTime.now(),
          );
          break;
      }
    });
  }

  void _resetBookingState() {
    state = state.copyWith(
      step: BookingStep.selectingPickup,
      destinationAddress: null,
      destinationLocation: null,
      estimatedDistance: null,
      estimatedFareAmount: null,
      estimatedTime: null,
      activeRoutePolyline: [],
      clearAssignedDriver: true,
      clearRideId: true,
      assignedDriverLocation: null,
      chatMessages: [],
    );
    _stopWatchdog();
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

    // Phase 2: Active Ride Recovery
    if (_apiClient != null && passengerId != 'unknown') {
      try {
        final response = await _apiClient!.dio.get('/rides/active/passenger');
        final data = response.data;
        if (data != null && data['rideId'] != null) {
          final rideId = data['rideId'];
          final status = data['status'];
          
          BookingStep restoredStep = BookingStep.searching;
          if (status == 'accepted') restoredStep = BookingStep.confirmed;
          else if (status == 'arrived') restoredStep = BookingStep.arrived;
          else if (status == 'in_progress' || status == 'started') restoredStep = BookingStep.started;

          state = state.copyWith(
            step: restoredStep,
            rideId: rideId,
            pickupLocation: LatLng(
                double.parse(data['pickupLat'].toString()), 
                double.parse(data['pickupLng'].toString())
            ),
            pickupAddress: data['pickupAddress'],
            destinationLocation: LatLng(
                double.parse(data['destinationLat'].toString()), 
                double.parse(data['destinationLng'].toString())
            ),
            destinationAddress: data['destinationAddress'],
            estimatedFareAmount: int.tryParse(data['fare'].toString()),
          );
          
          // Re-calculate route to show polyline on map
          if (state.pickupLocation != null && state.destinationLocation != null) {
            _calculateFare();
          }
          return; // Skip default search if recovered
        }
      } catch (e) {
        print('Active ride recovery failed: $e');
        state = state.copyWith(
          errorMessage: 'Could not restore your active ride. Please check your connection.',
        );
      }
    }

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
      step: BookingStep.previewEstimate,
    );
    if (state.pickupLocation != null) _calculateFare();
  }

  void setPaymentMethod(String method) {
    state = state.copyWith(paymentMethod: method);
  }

  Future<void> _calculateFare() async {
    state = state.copyWith(errorMessage: null, estimatedFareAmount: null);
    
    try {
      final estimate = await _mapRepo.calculateRouteAndFare(state.pickupLocation!, state.destinationLocation!);
      state = state.copyWith(
        estimatedDistance: estimate['distance'] as String,
        estimatedTime: estimate['time'] as String,
        estimatedFareAmount: estimate['fare'] as int,
        activeRoutePolyline: List<LatLng>.from(estimate['polyline']),
      );
    } catch (e) {
      state = state.copyWith(errorMessage: 'Failed to calculate fare.');
    }
  }

  void requestRide() {
    if (_socketService == null || state.pickupLocation == null || state.destinationLocation == null) return;

    final rideId = 'RIDE-${DateTime.now().millisecondsSinceEpoch}';
    
    // Join the ride room BEFORE emitting the request so no early broadcasts are missed
    _socketService!.emit('join', {'userId': rideId, 'role': 'ride'});

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
    
    state = state.copyWith(
      step: BookingStep.searching,
      rideId: rideId,
    );
    _startWatchdog();
  }

  Future<void> syncStatus() async {
    if (_apiClient == null || passengerId == 'unknown' || state.rideId == null) return;
    if (state.step == BookingStep.completed) return; // receipt is showing, don't disturb
    try {
      final response = await _apiClient!.dio.get('/rides/active/passenger');
      final data = response.data;
      if (data != null && data['rideId'] == state.rideId) {
        final status = data['status'];
        print('[PASSENGER_SYNC] Redundant healing caught status: $status');
        
        BookingStep targetStep = state.step;
        if (status == 'accepted') targetStep = BookingStep.confirmed;
        else if (status == 'arrived') targetStep = BookingStep.arrived;
        else if (status == 'in_progress' || status == 'started') targetStep = BookingStep.started;
        
        if (targetStep != state.step || state.assignedDriver == null) {
          print('[PASSENGER_SYNC] Healing state to $targetStep with driver: ${data['driverDetails']}');
          state = state.copyWith(
            step: targetStep,
            assignedDriver: data['driverDetails'],
          );
        }

        if (targetStep != BookingStep.searching) {
          _stopWatchdog();
        }
      }
    } catch (e) {
      print('Status sync failed: $e');
    }
  }

  void _startWatchdog() {
    _watchdogTimer?.cancel();
    print('[WATCHDOG] Starting sync watchdog...');
    _watchdogTimer = Timer.periodic(const Duration(seconds: 8), (_) {
      if (state.step == BookingStep.searching) {
        print('[WATCHDOG] Triggering redundant sync...');
        syncStatus();
      } else {
        _stopWatchdog();
      }
    });
  }

  void _stopWatchdog() {
    if (_watchdogTimer != null) {
      print('[WATCHDOG] Stopping sync watchdog.');
      _watchdogTimer?.cancel();
      _watchdogTimer = null;
    }
  }
  
  void _showReceipt() {
    state = state.copyWith(
      step: BookingStep.completed,
      receiptPickupAddress: state.pickupAddress,
      receiptDestinationAddress: state.destinationAddress,
      receiptFare: state.estimatedFareAmount,
      receiptPaymentMethod: state.paymentMethod,
      receiptDriver: state.assignedDriver,
      receiptDistance: state.estimatedDistance,
      receiptCompletedAt: DateTime.now(),
      chatMessages: [],
    );
  }

  void dismissReceipt() {
    _resetBookingState();
  }

  void sendChatMessage(String message) {
    if (_socketService == null || state.rideId == null || message.trim().isEmpty) return;
    _socketService!.emit('chat:send', {
      'rideId':     state.rideId,
      'senderId':   passengerId,
      'senderRole': 'passenger',
      'message':    message.trim(),
    });
  }

  void cancelBooking() {
    if (_socketService != null && state.rideId != null) {
      print('[PASSENGER_LIFECYCLE] Requesting cancellation for: ${state.rideId}');
      state = state.copyWith(step: BookingStep.loading);
      
      _socketService!.emit('ride:cancel', {
        'rideId': state.rideId,
        'passengerId': passengerId,
      });
      // NOTICE: We wait for the backend 'ride:cancelled' event for a strict sync.
    }
  }

  @override
  void dispose() {
    _debounceTimer?.cancel();
    _watchdogTimer?.cancel();
    _socketSubscription?.cancel();
    _notificationSubscription?.cancel();
    super.dispose();
  }
}

final bookingControllerProvider = StateNotifierProvider<BookingController, BookingState>((ref) {
  final apiClient = ref.watch(apiClientProvider);
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
  
  // Initial socket
  final socketService = ref.read(socketServiceProvider);
  final notificationService = ref.read(notificationServiceProvider('passenger'));
  final soundService = ref.read(soundServiceProvider);
  
  final controller = BookingController(mapRepo, socketService, apiClient, notificationService, soundService, passId, fname, lname);

  // Listen for socket updates without re-creating the controller
  ref.listen(socketServiceProvider, (previous, next) {
    controller.updateSocketService(next);
  });

  return controller;
});
