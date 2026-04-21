import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:dio/dio.dart' as dio;
import 'package:geolocator/geolocator.dart';
import '../domain/driver_profile.dart';
import '../domain/driver_state.dart';
import '../domain/trip_request.dart';
import '../../../core/network/socket_service.dart';
import '../../../core/network/socket_provider.dart';
import '../../../core/network/api_client.dart';
import '../../auth/application/auth_controller.dart';
import '../../auth/domain/auth_state.dart';
import 'package:jwt_decoder/jwt_decoder.dart';

class DriverController extends StateNotifier<DriverState> {
  SocketService? _socketService;
  final ApiClient _apiClient;
  final String _userId;

  Timer? _countdownTimer;
  Timer? _heartbeatTimer;
  Timer? _waitTimer;
  Timer? _watchdogTimer;
  StreamSubscription? _socketSubscription;

  DriverController(SocketService? initialSocket, this._apiClient, this._userId)
      : super(const DriverState(
          profile: DriverProfile(status: DriverStatus.unregistered),
        )) {
    _socketService = initialSocket;
    _initDriver();
    if (_socketService != null) _listenToSocket();
    _startHeartbeat();
  }

  void updateSocketService(SocketService? newService) {
    if (newService == _socketService) return;

    print('[SOCKET_SYNC] Socket Service updated. Re-linking...');
    _socketSubscription?.cancel();
    _socketService = newService;

    if (_socketService != null) {
      _listenToSocket();

      // If we have an active ride, immediately re-join the room
      if (state.activeRequest != null) {
        print('[SOCKET_SYNC] Re-joining ride room on new socket: ${state.activeRequest!.id}');
        _socketService!.emit('join', {'userId': state.activeRequest!.id, 'role': 'ride'});
        
        // Redundant sync to catch any state drift during the gap
        syncStatus();
      }
    }
  }

  void _listenToSocket() {
    if (_socketService == null) return;
    _socketSubscription = _socketService!.events.listen((data) {
      final event = data['event'];
      
      switch (event) {
        case 'ride:request':
          _handleIncomingRequest(data);
          break;
        case 'ride:cancelled':
          if (state.activeRequest?.id == data['rideId']) {
            _stopWatchdog();
            _resetToAvailable();
          }
          break;
        case 'socket:reconnected':
          print('[DRIVER_SYNC] Socket reconnected. Triggering redundant healing...');
          syncStatus();
          break;
        case 'ride:expired':
          if (state.activeRequest?.id == data['rideId']) {
            _handleTimeout();
          }
          break;
        case 'ride:finished':
          if (state.activeRequest?.id == data['rideId']) {
            _stopWatchdog();
            finishAndGoAvailable();
          }
          break;
      }
    });
  }

  void _resetToAvailable() {
    _waitTimer?.cancel();
    _countdownTimer?.cancel();
    state = state.copyWith(
      operationStatus: OperationStatus.available,
      activeRequest: null,
      countdown: null,
      tripStep: TripStep.none,
      waitTimeSeconds: 0,
    );
  }

  void _startHeartbeat() {
    _heartbeatTimer?.cancel();
    _sendHeartbeat();
    _heartbeatTimer = Timer.periodic(const Duration(seconds: 12), (_) => _sendHeartbeat());
  }

  Future<void> _sendHeartbeat() async {
    if (!mounted) return;
    if (state.operationStatus == OperationStatus.available && _socketService != null) {
      double lat, lng;
      if (state.mockLocation != null) {
        lat = state.mockLocation!.latitude;
        lng = state.mockLocation!.longitude;
      } else {
        try {
          final position = await Geolocator.getCurrentPosition();
          lat = position.latitude;
          lng = position.longitude;
        } catch (_) {
          return; // Skip heartbeat if we can't get real location and no mock exists
        }
      }
      if (!mounted) return;
      
      final isMock = state.mockLocation != null;
      print('===================================================');
      print('[DEBUG:HEARTBEAT] Source: ${isMock ? "MOCK" : "REAL GPS"}');
      print('[DEBUG:HEARTBEAT] Payload: lat=$lat lng=$lng');
      print('===================================================');
      
      _socketService!.emit('driver:heartbeat', {
        'driverId': _userId,
        'lat': lat,
        'lng': lng,
      });
    }
  }

  void setMockLocation(LatLng pos) {
    print('[DEBUG:MOCK] LONG-PRESS MAP OVERRIDE TRIGGERED at: lat=${pos.latitude}, lng=${pos.longitude}');
    state = state.copyWith(mockLocation: pos);
    print('[DEBUG:MOCK] driverState updated. mockLocation is now: ${state.mockLocation?.latitude}, ${state.mockLocation?.longitude}');
    if (state.operationStatus == OperationStatus.available) _sendHeartbeat();
  }

  void clearMockLocation() {
    state = state.copyWith(clearMockLocation: true);
    if (state.operationStatus == OperationStatus.available) _sendHeartbeat();
  }

  void _handleIncomingRequest(Map<String, dynamic> data) {
    if (state.operationStatus != OperationStatus.available) return;

    final request = TripRequest(
      id: data['rideId'],
      passengerId: data['passengerId'] ?? 'unknown',
      isCash: data['isCash'] ?? true,
      passengerName: data['passengerName'],
      pickupAddress: data['pickupAddress'],
      pickupLocation: LatLng(data['pickupLat'], data['pickupLng']),
      destinationAddress: data['destinationAddress'],
      destinationLocation: LatLng(data['destinationLat'], data['destinationLng']),
      fare: (data['fare'] as num).toDouble(),
      distance: 0,
      countdownSeconds: 30,
    );

    state = state.copyWith(
      operationStatus: OperationStatus.busy,
      activeRequest: request,
      countdown: 30,
    );

    _startCountdown();
  }



  Future<void> _initDriver() async {
    // Small delay ensures Riverpod state finishes spreading before we hit the network
    await Future.delayed(const Duration(milliseconds: 200));
    if (!mounted) return;

    state = state.copyWith(isLoading: true);
    try {
      final response = await _apiClient.dio.get('/drivers/status/$_userId');
      if (!mounted) return;

      final data = response.data;
      
      if (data != null && data['status'] != 'unregistered') {
        state = state.copyWith(
          profile: DriverProfile(
            id: _userId,
            firstName: data['firstName'],
            lastName: data['lastName'],
            status: _mapStatus(data['status']),
            vehiclePlate: data['vehiclePlate'],
            vehicleModel: data['vehicleModel'],
            licenseUrl: data['licenseUrl'],
            idCardUrl: data['idCardUrl'],
            vehiclePaperUrl: data['vehiclePaperUrl'],
            debtAmount: 0.0,
          ),
          isLoading: false,
        );

        // Phase 2: Active Ride Recovery
        try {
          final rideResponse = await _apiClient.dio.get('/rides/active/driver');
          final rideData = rideResponse.data;
          if (rideData != null && rideData['rideId'] != null) {
            final rideId = rideData['rideId'];
            final status = rideData['status'];
            
            TripStep step = TripStep.accepted;
            if (status == 'arrived') step = TripStep.arrived;
            else if (status == 'in_progress' || status == 'started') step = TripStep.started;

            final recoveredRequest = TripRequest(
              id: rideData['rideId'],
              passengerId: rideData['passengerId'],
              isCash: rideData['paymentMode'] == 'cash',
              passengerName: 'User', // Generic placeholder for recovery
              pickupAddress: rideData['pickupAddress'] ?? '',
              pickupLocation: LatLng(
                  double.parse(rideData['pickupLat'].toString()), 
                  double.parse(rideData['pickupLng'].toString())
              ),
              destinationAddress: rideData['destinationAddress'] ?? '',
              destinationLocation: LatLng(
                  double.parse(rideData['destinationLat'].toString()), 
                  double.parse(rideData['destinationLng'].toString())
              ),
              fare: double.parse(rideData['fare'].toString()),
              distance: 0,
            );

            state = state.copyWith(
              operationStatus: OperationStatus.busy,
              tripStep: step,
              activeRequest: recoveredRequest,
            );
            _startWatchdog();
          }
        } catch (e) {
          print('Active ride recovery failed for driver: $e');
        }
      } else {
        state = state.copyWith(isLoading: false);
      }
    } catch (e) {
      if (!mounted) return;
      state = state.copyWith(isLoading: false, errorMessage: 'Failed to sync status: ${e.toString()}');
    }
  }

  DriverStatus _mapStatus(String status) {
    switch (status) {
      case 'pending_documents': return DriverStatus.pendingDocuments;
      case 'pending_review': return DriverStatus.pendingApproval;
      case 'approved': return DriverStatus.approved;
      case 'rejected': return DriverStatus.rejected;
      case 'suspended': return DriverStatus.suspended;
      default: return DriverStatus.unregistered;
    }
  }

  void setDriverStatus(DriverStatus status) {
    state = state.copyWith(profile: state.profile.copyWith(status: status));
  }

  // --- Onboarding & Status ---
  
  Future<void> submitOnboarding({
    required String plate,
    required String model,
  }) async {
    state = state.copyWith(isLoading: true, errorMessage: null);
    try {
      final response = await _apiClient.dio.post('/drivers/onboarding', data: {
        'userId': _userId,
        'firstName': 'Driver', // Placeholder until Auth update
        'lastName': 'User',
        'vehiclePlate': plate,
        'vehicleModel': model,
      });

      if (!mounted) return;

      final rawData = response.data;
      print('[DEBUG:ONBOARDING] Raw response: $rawData (Type: ${rawData.runtimeType})');

      if (rawData == null || rawData is! Map) {
        throw 'Invalid backend response: Expected Map, got ${rawData.runtimeType}';
      }

      final Map<String, dynamic> responseBody = Map<String, dynamic>.from(rawData);
      final newStatusStr = responseBody['status']?.toString() ?? 'pending_documents';
      final newStatus = _mapStatus(newStatusStr);

      print('[DEBUG:ONBOARDING] Parsed status: $newStatus');

      state = state.copyWith(
        profile: state.profile.copyWith(
          id: _userId,
          status: newStatus,
          vehiclePlate: plate,
          vehicleModel: model,
        ),
      );
    } catch (e) {
      if (!mounted) return;
      String msg = 'Onboarding failed';
      if (e is dio.DioException) {
        final errData = e.response?.data;
        print('[DEBUG:ONBOARDING] Raw error response: $errData (Type: ${errData.runtimeType})');
        
        if (errData is Map) {
          msg = 'Onboarding failed: ${errData['error'] ?? e.message}';
        } else if (errData is String && errData.isNotEmpty) {
          msg = 'Onboarding failed: $errData';
        } else {
          msg = 'Onboarding failed: ${e.message}';
        }
      } else {
        msg = 'Onboarding failed: ${e.toString()}';
      }
      print('[DEBUG:ONBOARDING] Final error message: $msg');
      state = state.copyWith(errorMessage: msg);
    } finally {
      if (mounted) {
        state = state.copyWith(isLoading: false);
      }
    }
  }

  Future<void> uploadDocument(String filePath, String docType) async {
    state = state.copyWith(isLoading: true, errorMessage: null);
    try {
      final formData = dio.FormData.fromMap({
        'userId': _userId,
        'docType': docType,
        'document': await dio.MultipartFile.fromFile(filePath),
      });

      if (!mounted) return;

      final response = await _apiClient.dio.post(
        '/drivers/upload',
        data: formData,
      );

      if (!mounted) return;

      final rawData = response.data;
      print('[DEBUG:UPLOAD] Raw response: $rawData (Type: ${rawData.runtimeType})');

      if (rawData == null || rawData is! Map) {
        throw 'Invalid backend response: Expected Map, got ${rawData.runtimeType}';
      }

      final Map<String, dynamic> responseBody = Map<String, dynamic>.from(rawData);
      final newStatusStr = responseBody['status']?.toString() ?? 'pending_documents';
      final newStatus = _mapStatus(newStatusStr);
      final filename = responseBody['filename']?.toString() ?? 'uploaded';

      print('[DEBUG:UPLOAD] Parsed status: $newStatus, Filename: $filename');

      state = state.copyWith(
        profile: state.profile.copyWith(
          status: newStatus,
          licenseUrl: docType == 'license' ? filename : state.profile.licenseUrl,
          idCardUrl: docType == 'id_card' ? filename : state.profile.idCardUrl,
          vehiclePaperUrl: docType == 'vehicle_paper' ? filename : state.profile.vehiclePaperUrl,
        ),
      );
    } catch (e) {
      if (!mounted) return;
      String msg = 'Upload failed';
      if (e is dio.DioException) {
        final errData = e.response?.data;
        print('[DEBUG:UPLOAD] Raw error response: $errData (Type: ${errData.runtimeType})');
        
        if (errData is Map) {
          msg = 'Upload failed: ${errData['error'] ?? e.message}';
        } else if (errData is String && errData.isNotEmpty) {
          if (errData.contains('413 Request Entity Too Large') || e.response?.statusCode == 413) {
            msg = 'Upload failed: The selected photo is too large for upload. Please try again.';
          } else if (errData.startsWith('<html>')) {
            msg = 'Upload failed: Server error (${e.response?.statusCode ?? "Unknown"})';
          } else {
            msg = 'Upload failed: $errData';
          }
        } else {
          msg = 'Upload failed: ${e.message}';
        }
      } else {
        msg = 'Upload failed: ${e.toString()}';
      }
      print('[DEBUG:UPLOAD] Final error message: $msg');
      state = state.copyWith(errorMessage: msg);
    } finally {
      if (mounted) {
        state = state.copyWith(isLoading: false);
      }
    }
  }

  void toggleOnline() {
    if (state.profile.status != DriverStatus.approved) {
      print('[DEBUG:TOGGLE] Prevented online toggle, status is ${state.profile.status}');
      return;
    }

    if (state.operationStatus == OperationStatus.offline) {
      print('[DEBUG:TOGGLE] Driver going ONLINE. Starting heartbeat...');
      state = state.copyWith(operationStatus: OperationStatus.available);
      _startHeartbeat(); // Ensure heartbeat fires immediately to get into Redis
    } else {
      print('[DEBUG:TOGGLE] Driver going OFFLINE. Stopping heartbeat...');
      state = state.copyWith(operationStatus: OperationStatus.offline);
      _heartbeatTimer?.cancel();
      if (_socketService != null) {
        _socketService!.emit('driver:offline', {'driverId': _userId});
      }
    }
  }

  // --- Real Request Flow ---

  void acceptRequest() {
    if (_socketService == null || state.activeRequest == null) return;
    
    _socketService!.emit('ride:accept', {
      'rideId': state.activeRequest!.id,
      'driverId': _userId,
      'driverDetails': {
        'name': '${state.profile.firstName ?? 'Driver'} ${state.profile.lastName ?? ''}',
        'plate': state.profile.vehiclePlate,
        'model': state.profile.vehicleModel,
      }
    });

    _countdownTimer?.cancel();
    state = state.copyWith(
      tripStep: TripStep.accepted,
      countdown: null,
    );
    _startWatchdog();
  }

  void rejectRequest() {
    if (_socketService == null || state.activeRequest == null) return;

    _socketService!.emit('ride:reject', {
      'rideId': state.activeRequest!.id,
      'driverId': _userId,
    });

    _countdownTimer?.cancel();
    state = state.copyWith(
      operationStatus: OperationStatus.available,
      activeRequest: null,
      countdown: null,
    );
  }

  void _startCountdown() {
    _countdownTimer?.cancel();
    _countdownTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) {
        timer.cancel();
        return;
      }
      if (state.countdown == null || state.countdown! <= 0) {
        timer.cancel();
        _handleTimeout();
      } else {
        state = state.copyWith(countdown: state.countdown! - 1);
      }
    });
  }

  void _handleTimeout() {
    state = state.copyWith(
      operationStatus: OperationStatus.available,
      activeRequest: null,
      countdown: null,
      tripStep: TripStep.none,
    );
  }

  // --- Trip Lifecycle ---

  void markArrived() {
    if (_socketService == null || state.activeRequest == null) return;
    
    _socketService!.emit('ride:arrived', {
      'rideId': state.activeRequest!.id,
      'driverId': _userId,
    });

    state = state.copyWith(tripStep: TripStep.arrived, waitTimeSeconds: 0);
    
    _waitTimer?.cancel();
    _waitTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (mounted) {
        state = state.copyWith(waitTimeSeconds: state.waitTimeSeconds + 1);
      }
    });
  }
  
  void startTrip() {
    if (_socketService == null || state.activeRequest == null) return;

    _socketService!.emit('ride:start', {
      'rideId': state.activeRequest!.id,
      'driverId': _userId,
    });

    _waitTimer?.cancel();
    state = state.copyWith(tripStep: TripStep.started);
  }

  void completeTrip() {
    if (_socketService == null || state.activeRequest == null) return;

    // Calculate Wait Time Surcharge (e.g. 5 minutes grace period, then ₦10 per minute)
    int waitCharge = 0;
    if (state.waitTimeSeconds > 300) {
      int extraMinutes = ((state.waitTimeSeconds - 300) / 60).ceil();
      waitCharge = extraMinutes * 10;
    }
    final totalFare = state.activeRequest!.fare + waitCharge;

    _socketService!.emit('ride:complete', {
      'rideId': state.activeRequest!.id,
      'passengerId': state.activeRequest!.passengerId,
      'driverId': _userId,
      'totalFare': totalFare,
      'isCash': state.activeRequest!.isCash,
      'waitTimeSeconds': state.waitTimeSeconds, // Send to backend for record logic if needed
    });

    state = state.copyWith(
      tripStep: TripStep.completed,
    );
  }

  void finishAndGoAvailable() {
    state = state.copyWith(
      tripStep: TripStep.none,
      activeRequest: null,
      operationStatus: OperationStatus.available,
      waitTimeSeconds: 0,
    );
    _stopWatchdog();
  }

  Future<void> syncStatus() async {
    if (state.activeRequest == null) return;
    try {
      final response = await _apiClient.dio.get('/rides/active/driver');
      final data = response.data;
      if (data != null && data['rideId'] == state.activeRequest!.id) {
        final status = data['status'];
        print('[DRIVER_SYNC] Redundant healing caught status: $status');

        TripStep targetStep = state.tripStep;
        if (status == 'arrived') targetStep = TripStep.arrived;
        else if (status == 'in_progress' || status == 'started') targetStep = TripStep.started;

        if (targetStep != state.tripStep) {
          state = state.copyWith(tripStep: targetStep);
        }
      } else if (data == null || data['rideId'] == null) {
         // Server says no active ride, but we think we have one? 
         // Force reset to available.
         print('[DRIVER_SYNC] Server says no active ride. Force resetting.');
         _stopWatchdog();
         finishAndGoAvailable();
      }
    } catch (e) {
      print('Status sync failed: $e');
    }
  }

  void _startWatchdog() {
    _watchdogTimer?.cancel();
    print('[WATCHDOG] Starting driver sync watchdog...');
    _watchdogTimer = Timer.periodic(const Duration(seconds: 10), (_) {
      if (state.activeRequest != null) {
        print('[WATCHDOG] Triggering redundant sync...');
        syncStatus();
      } else {
        _stopWatchdog();
      }
    });
  }

  void _stopWatchdog() {
    if (_watchdogTimer != null) {
      print('[WATCHDOG] Stopping driver sync watchdog.');
      _watchdogTimer?.cancel();
      _watchdogTimer = null;
    }
  }

  @override
  void dispose() {
    _waitTimer?.cancel();
    _countdownTimer?.cancel();
    _heartbeatTimer?.cancel();
    _watchdogTimer?.cancel();
    _socketSubscription?.cancel();
    super.dispose();
  }
}

final driverControllerProvider = StateNotifierProvider<DriverController, DriverState>((ref) {
  final apiClient = ref.watch(apiClientProvider);
  final authState = ref.watch(authControllerProvider);
  
  String userId = 'guest';
  if (authState.status == AuthStatus.authenticated && authState.token != null) {
    try {
      final decodedToken = JwtDecoder.decode(authState.token!);
      final extractedId = decodedToken['userId'];
      
      if (extractedId == null || extractedId.toString().isEmpty) {
        throw 'Missing userId in token';
      }
      
      userId = extractedId.toString();
    } catch (e) {
      print('[CRITICAL:AUTH] JWT Decode failed or userId missing: $e');
      Future.microtask(() {
        ref.read(authControllerProvider.notifier).forceUnauthorizedCleanup();
      });
      return DriverController(null, apiClient, 'session_invalid');
    }
  }

  // Initial socket
  final socketService = ref.read(socketServiceProvider);

  final controller = DriverController(socketService, apiClient, userId);

  // Listen for socket updates without re-creating the controller
  ref.listen(socketServiceProvider, (previous, next) {
    controller.updateSocketService(next);
  });

  return controller;
});
