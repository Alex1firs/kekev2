import 'dart:async';
import 'dart:math' as math;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import '../domain/booking_state.dart';
import '../data/map_repository.dart';
import '../../../core/network/socket_service.dart';
import '../../../core/network/socket_provider.dart';
import '../../../core/network/api_client.dart';
import '../../auth/application/auth_controller.dart';
import '../../auth/domain/auth_state.dart';
import 'wallet_controller.dart';
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
  Timer? _searchTimeoutTimer;
  Timer? _nearbyPollingTimer;
  Timer? _errorClearTimer;
  StreamSubscription? _socketSubscription;
  StreamSubscription? _notificationSubscription;
  final NotificationService _notificationService;
  final SoundService _soundService;
  void Function()? _onWalletRefreshNeeded;

  void setWalletRefreshCallback(void Function() cb) => _onWalletRefreshNeeded = cb;

  BookingController(this._mapRepo, SocketService? initialSocket, this._apiClient, this._notificationService, this._soundService, this.passengerId, this.firstName, this.lastName) : super(const BookingState()) {
    _socketService = initialSocket;
    _initializeMap();
    if (_socketService != null) _listenToSocket();
    _listenToNotifications();
    _startNearbyPolling();
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
          _searchTimeoutTimer?.cancel();
          state = state.copyWith(
            step: BookingStep.confirmed,
            assignedDriver: data['driverDetails'],
            pickupCode: data['pickupCode']?.toString(),
            clearErrorMessage: true,
          );
          _stopWatchdog();
          _soundService.playAlert();
          break;
        case 'ride:status_update':
           print('[PASSENGER_SYNC] Status update: ${data['status']}');
           if (data['status'] == 'arrived') {
             state = state.copyWith(
               step: BookingStep.arrived,
               clearApproachRoute: true,
               clearEta: true,
             );
             _soundService.playAlert();
           } else if (data['status'] == 'started') {
             state = state.copyWith(
               step: BookingStep.started,
               clearApproachRoute: true,
               clearLastApproachOrigin: true,
               clearEta: true,
               clearDestinationEta: true,
             );
           }
           break;
        case 'chat:message':
          try {
            final msg = ChatMessage(
              senderId:   data['senderId']?.toString() ?? '',
              senderRole: data['senderRole']?.toString() ?? 'driver',
              message:    data['message']?.toString() ?? '',
              timestamp:  DateTime.tryParse(data['timestamp']?.toString() ?? '') ?? DateTime.now(),
            );
            state = state.copyWith(chatMessages: [...state.chatMessages, msg]);
          } catch (e) {
            print('[PASSENGER] Failed to parse chat message: $e');
          }
          break;
        case 'ride:cancelled':
          print('[PASSENGER_SYNC] Ride cancelled. Resetting state.');
          _searchTimeoutTimer?.cancel();
          _stopWatchdog();
          _resetBookingState();
          break;
        case 'ride:finished':
          print('[PASSENGER_SYNC] Ride finished. Showing receipt.');
          _searchTimeoutTimer?.cancel();
          _stopWatchdog();
          _showReceipt();
          _onWalletRefreshNeeded?.call();
          break;
        case 'ride:failed':
          _searchTimeoutTimer?.cancel();
          _stopWatchdog();
          state = state.copyWith(
            step: BookingStep.previewEstimate,
            errorMessage: data['message']?.toString() ?? 'No drivers available right now — please try again.',
          );
          break;
        case 'driver:location_update':
          try {
            final driverLoc = LatLng(
              (data['lat'] as num?)?.toDouble() ?? 0.0,
              (data['lng'] as num?)?.toDouble() ?? 0.0,
            );
            if (state.step == BookingStep.confirmed && state.pickupLocation != null) {
              final dist = _haversineDistance(driverLoc, state.pickupLocation!);
              final eta = (dist / 230).clamp(0.0, 999.0);
              final nearby = dist < 150;
              // Re-fetch approach polyline when driver moves >50 m from last fetch origin
              final lastOrigin = state.lastApproachOrigin;
              if (lastOrigin == null || _haversineDistance(driverLoc, lastOrigin) > 50) {
                _fetchApproachRoute(driverLoc);
              }
              state = state.copyWith(
                assignedDriverLocation: driverLoc,
                lastLocationUpdate: DateTime.now(),
                etaMinutes: eta,
                distanceToPickupMeters: dist,
                isDriverNearby: nearby,
                clearDestinationEta: true,
              );
            } else if (state.step == BookingStep.started && state.destinationLocation != null) {
              final destDist = _haversineDistance(driverLoc, state.destinationLocation!);
              final destEta = (destDist / 230).clamp(0.0, 999.0);
              state = state.copyWith(
                assignedDriverLocation: driverLoc,
                lastLocationUpdate: DateTime.now(),
                etaToDestinationMinutes: destEta,
                distanceToDestinationMeters: destDist,
                clearEta: true,
              );
            } else {
              state = state.copyWith(
                assignedDriverLocation: driverLoc,
                lastLocationUpdate: DateTime.now(),
              );
            }
          } catch (e) {
            print('[PASSENGER] Failed to parse driver location: $e');
          }
          break;
        case 'socket:disconnected':
          if (state.step == BookingStep.searching) {
            state = state.copyWith(errorMessage: 'Connection lost — your search continues in the background.');
            _scheduleErrorClear(seconds: 8);
          }
          break;
      }
    });
  }

  void _resetBookingState() {
    // Construct cleanly so all receipt/ride fields truly reset to null defaults.
    state = BookingState(
      step: BookingStep.selectingDestination,
      mapCenter: state.mapCenter,
      pickupLocation: state.pickupLocation,
      pickupAddress: 'Locating...',
      paymentMethod: state.paymentMethod,
    );
    _stopWatchdog();
    // Re-detect current location — the passenger is now at the trip destination,
    // not the original pickup point.
    _refreshCurrentLocation();
  }

  Future<void> _refreshCurrentLocation() async {
    final location = await _mapRepo.getCurrentLocation();
    if (location == null || !mounted) return;
    state = state.copyWith(
      mapCenter: location,
      pickupLocation: location,
      pickupAddress: 'Locating...',
    );
    _triggerReverseGeocode(location, isPickup: true);
    _fetchNearbyDrivers();
  }

  /// Haversine great-circle distance between two coordinates, in metres.
  double _haversineDistance(LatLng a, LatLng b) {
    const r = 6371000.0;
    final dLat = (b.latitude - a.latitude) * math.pi / 180;
    final dLon = (b.longitude - a.longitude) * math.pi / 180;
    final sinDLat = math.sin(dLat / 2);
    final sinDLon = math.sin(dLon / 2);
    final aVal = sinDLat * sinDLat +
        math.cos(a.latitude * math.pi / 180) *
            math.cos(b.latitude * math.pi / 180) *
            sinDLon * sinDLon;
    return r * 2 * math.atan2(math.sqrt(aVal), math.sqrt(1 - aVal));
  }

  Future<void> _fetchApproachRoute(LatLng driverLoc) async {
    if (state.pickupLocation == null) return;
    final points = await _mapRepo.getRoutePath(driverLoc, state.pickupLocation!);
    if (mounted && state.step == BookingStep.confirmed && points.isNotEmpty) {
      state = state.copyWith(
        approachRoutePolyline: points,
        lastApproachOrigin: driverLoc,
      );
    }
  }

  Future<void> _initializeMap() async {
    final defaultLocation = const LatLng(6.1264, 6.7876); // Awka fallback
    final userLocation = await _mapRepo.getCurrentLocation();
    final center = userLocation ?? defaultLocation;

    state = state.copyWith(
      step: BookingStep.selectingDestination,
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
                (data['pickupLat'] as num?)?.toDouble() ?? 0.0,
                (data['pickupLng'] as num?)?.toDouble() ?? 0.0,
            ),
            pickupAddress: data['pickupAddress']?.toString(),
            destinationLocation: LatLng(
                (data['destinationLat'] as num?)?.toDouble() ?? 0.0,
                (data['destinationLng'] as num?)?.toDouble() ?? 0.0,
            ),
            destinationAddress: data['destinationAddress']?.toString(),
            estimatedFareAmount: int.tryParse(data['fare']?.toString() ?? ''),
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
    
    // Fetch drivers now that we have a location
    _fetchNearbyDrivers();
  }

  void onCameraMove(CameraPosition position) {
    if (state.step != BookingStep.selectingPickup && state.step != BookingStep.selectingDestinationOnMap && state.step != BookingStep.idle) return;

    state = state.copyWith(
      isCameraMoving: true,
      mapCenter: position.target,
    );
    _debounceTimer?.cancel();
  }

  void onCameraIdle() {
    if (state.step != BookingStep.selectingPickup && state.step != BookingStep.selectingDestinationOnMap) return;
    
    state = state.copyWith(isCameraMoving: false);
    final target = state.mapCenter;
    if (target != null) {
      _debounceTimer?.cancel();
      _debounceTimer = Timer(const Duration(milliseconds: 400), () {
        _triggerReverseGeocode(target, isPickup: state.step == BookingStep.selectingPickup);
        _fetchNearbyDrivers();
      });
    }
  }

  Future<void> _triggerReverseGeocode(LatLng target, {required bool isPickup}) async {
    if (isPickup) {
      state = state.copyWith(pickupLocation: target, pickupAddress: 'Loading address...');
    } else {
      state = state.copyWith(destinationLocation: target, destinationAddress: 'Loading address...');
    }
    
    final address = await _mapRepo.reverseGeocode(target);
    
    if (isPickup && (state.step == BookingStep.selectingPickup ||
        state.step == BookingStep.selectingDestination)) {
      state = state.copyWith(pickupAddress: address);
    } else if (!isPickup && state.step == BookingStep.selectingDestinationOnMap) {
      state = state.copyWith(destinationAddress: address);
    }
  }

  void confirmPickup() {
    if (state.pickupLocation == null) return;
    state = state.copyWith(step: BookingStep.selectingDestination);
  }

  void retreatToPickup() {
    // Go back to the home/destination panel and clear all fare/route state.
    state = BookingState(
      step: BookingStep.selectingDestination,
      mapCenter: state.mapCenter,
      pickupLocation: state.pickupLocation,
      pickupAddress: state.pickupAddress,
      nearbyDrivers: state.nearbyDrivers,
      paymentMethod: state.paymentMethod,
    );
  }

  void cancelPickupEdit() {
    state = state.copyWith(step: BookingStep.selectingDestination);
  }

  void enterPickupMapSelection() {
    state = state.copyWith(
      step: BookingStep.selectingPickup,
      mapCenter: state.pickupLocation,
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

  void startDestinationMapSelection() {
    state = state.copyWith(
      step: BookingStep.selectingDestinationOnMap,
      mapCenter: state.pickupLocation, // Start where they are
    );
    if (state.mapCenter != null) {
      _triggerReverseGeocode(state.mapCenter!, isPickup: false);
    }
  }

  void confirmDestinationOnMap() {
    if (state.destinationLocation == null) return;
    state = state.copyWith(step: BookingStep.previewEstimate);
    _calculateFare();
  }

  void setPaymentMethod(String method) {
    state = state.copyWith(paymentMethod: method);
  }

  Future<void> _calculateFare() async {
    state = state.copyWith(clearErrorMessage: true, estimatedFareAmount: null);

    try {
      final estimate = await _mapRepo.calculateRouteAndFare(state.pickupLocation!, state.destinationLocation!);
      state = state.copyWith(
        estimatedDistance: estimate['distance'] as String,
        estimatedTime: estimate['time'] as String,
        estimatedFareAmount: estimate['fare'] as int,
        activeRoutePolyline: List<LatLng>.from(estimate['polyline']),
      );
    } catch (e) {
      state = state.copyWith(errorMessage: 'Couldn\'t calculate your route — try a different destination.');
    }
  }

  void requestRide() {
    if (_socketService == null) {
      state = state.copyWith(errorMessage: 'Not connected to server — please restart the app and try again.');
      return;
    }
    if (state.pickupLocation == null || state.destinationLocation == null) return;
    if (!_socketService!.isConnected) {
      state = state.copyWith(errorMessage: 'No connection — please check your internet and try again.');
      return;
    }

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

  void _startNearbyPolling() {
    _nearbyPollingTimer?.cancel();
    
    // Fetch immediately on start
    _fetchNearbyDrivers();
    
    _nearbyPollingTimer = Timer.periodic(const Duration(seconds: 10), (_) {
      if (state.step == BookingStep.selectingPickup || 
          state.step == BookingStep.selectingDestination || 
          state.step == BookingStep.previewEstimate || 
          state.step == BookingStep.idle) {
        _fetchNearbyDrivers();
      }
    });
  }

  Future<void> _fetchNearbyDrivers() async {
    if (_apiClient == null || state.pickupLocation == null) return;
    
    // Use mapCenter if idle/selecting, or pickupLocation if locked in
    final targetLocation = (state.step == BookingStep.selectingPickup || state.step == BookingStep.idle) 
        ? (state.mapCenter ?? state.pickupLocation!) 
        : state.pickupLocation!;

    try {
      final response = await _apiClient!.dio.get(
        '/drivers/nearby',
        queryParameters: {
          'lat': targetLocation.latitude,
          'lng': targetLocation.longitude,
          'radius': 5,
        },
      );
      
      final data = response.data;
      if (data != null && data['drivers'] != null) {
        final List<LatLng> drivers = (data['drivers'] as List).map((d) {
          return LatLng((d['lat'] as num).toDouble(), (d['lng'] as num).toDouble());
        }).toList();

        if (mounted) {
          state = state.copyWith(nearbyDrivers: drivers);
        }
      }
    } catch (e) {
      print('Failed to fetch nearby drivers: $e');
    }
  }

  void _startWatchdog() {
    _watchdogTimer?.cancel();
    _searchTimeoutTimer?.cancel();
    print('[WATCHDOG] Starting sync watchdog...');
    _watchdogTimer = Timer.periodic(const Duration(seconds: 8), (_) {
      if (state.step == BookingStep.searching) {
        print('[WATCHDOG] Triggering redundant sync...');
        syncStatus();
      } else {
        _stopWatchdog();
      }
    });
    // Auto-rollback if no driver found within 90 seconds
    _searchTimeoutTimer = Timer(const Duration(seconds: 90), () {
      if (mounted && state.step == BookingStep.searching) {
        print('[WATCHDOG] Search timed out — rolling back to estimate.');
        _stopWatchdog();
        state = state.copyWith(
          step: BookingStep.previewEstimate,
          clearRideId: true,
          errorMessage: 'No drivers available right now — please try again.',
        );
      }
    });
  }

  void _stopWatchdog() {
    if (_watchdogTimer != null) {
      print('[WATCHDOG] Stopping sync watchdog.');
      _watchdogTimer?.cancel();
      _watchdogTimer = null;
    }
    _searchTimeoutTimer?.cancel();
    _searchTimeoutTimer = null;
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

  bool sendChatMessage(String message) {
    if (_socketService == null || state.rideId == null || message.trim().isEmpty) return false;
    if (!_socketService!.isConnected) return false;
    _socketService!.emit('chat:send', {
      'rideId':     state.rideId,
      'senderId':   passengerId,
      'senderRole': 'passenger',
      'message':    message.trim(),
    });
    return true;
  }

  void clearError() {
    _errorClearTimer?.cancel();
    if (mounted) state = state.copyWith(clearErrorMessage: true);
  }

  void _scheduleErrorClear({int seconds = 5}) {
    _errorClearTimer?.cancel();
    _errorClearTimer = Timer(Duration(seconds: seconds), () {
      if (mounted) state = state.copyWith(clearErrorMessage: true);
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

      // Fallback: if the server never echoes ride:cancelled (socket blip), reset anyway.
      Future.delayed(const Duration(seconds: 6), () {
        if (mounted && state.step == BookingStep.loading) {
          print('[PASSENGER_LIFECYCLE] Cancel fallback triggered — resetting state');
          _resetBookingState();
        }
      });
    }
  }

  @override
  void dispose() {
    _debounceTimer?.cancel();
    _watchdogTimer?.cancel();
    _searchTimeoutTimer?.cancel();
    _nearbyPollingTimer?.cancel();
    _errorClearTimer?.cancel();
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

  controller.setWalletRefreshCallback(
    () => ref.read(walletControllerProvider.notifier).refresh(),
  );

  // Listen for socket updates without re-creating the controller
  ref.listen(socketServiceProvider, (previous, next) {
    controller.updateSocketService(next);
  });

  return controller;
});
