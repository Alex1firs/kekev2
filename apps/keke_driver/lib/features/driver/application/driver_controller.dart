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

class DriverController extends StateNotifier<DriverState> {
  final SocketService? _socketService;
  final ApiClient _apiClient;
  final String _userId;

  Timer? _countdownTimer;
  Timer? _heartbeatTimer;
  StreamSubscription? _socketSubscription;

  DriverController(this._socketService, this._apiClient, this._userId)
      : super(const DriverState(
          profile: DriverProfile(status: DriverStatus.unregistered),
        )) {
    _initDriver();
    _listenToSocket();
    _startHeartbeat();
  }

  void _listenToSocket() {
    if (_socketService == null) return;
    _socketSubscription = _socketService!.events.listen((data) {
      final event = data['event'];
      
      switch (event) {
        case 'ride:request':
          _handleIncomingRequest(data);
          break;
        case 'ride:expired':
          if (state.activeRequest?.id == data['rideId']) {
            _handleTimeout();
          }
          break;
      }
    });
  }

  void _startHeartbeat() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = Timer.periodic(const Duration(seconds: 12), (timer) async {
      if (state.operationStatus == OperationStatus.available && _socketService != null) {
        final position = await Geolocator.getCurrentPosition();
        _socketService!.emit('driver:heartbeat', {
          'driverId': _userId,
          'lat': position.latitude,
          'lng': position.longitude,
        });
      }
    });
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
    state = state.copyWith(isLoading: true);
    try {
      final response = await _apiClient.dio.get('/drivers/status/$_userId');
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
            debtAmount: 0.0, // Should be fetched from finance in a real app
          ),
          isLoading: false,
        );
      } else {
        state = state.copyWith(isLoading: false);
      }
    } catch (e) {
      state = state.copyWith(isLoading: false, errorMessage: 'Failed to sync status');
    }
  }

  DriverStatus _mapStatus(String status) {
    switch (status) {
      case 'pending_documents': return DriverStatus.pendingDocuments;
      case 'pending_review': return DriverStatus.pendingReview;
      case 'approved': return DriverStatus.approved;
      case 'rejected': return DriverStatus.rejected;
      case 'suspended': return DriverStatus.suspended;
      default: return DriverStatus.unregistered;
    }
  }

  // --- Onboarding & Status ---
  
  Future<void> submitOnboarding({
    required String plate,
    required String model,
  }) async {
    state = state.copyWith(isLoading: true);
    try {
      final response = await _apiClient.dio.post('/drivers/onboarding', {
        'userId': _userId,
        'firstName': 'Driver', // Placeholder until Auth update
        'lastName': 'User',
        'vehiclePlate': plate,
        'vehicleModel': model,
      });

      final newStatus = _mapStatus(response.data['status']);

      state = state.copyWith(
        isLoading: false,
        profile: state.profile.copyWith(
          id: _userId,
          status: newStatus,
          vehiclePlate: plate,
          vehicleModel: model,
        ),
      );
    } catch (e) {
      state = state.copyWith(isLoading: false, errorMessage: 'Onboarding failed');
    }
  }

  Future<void> uploadDocument(String filePath, String docType) async {
    state = state.copyWith(isLoading: true);
    try {
      final formData = dio.FormData.fromMap({
        'userId': _userId,
        'docType': docType,
        'document': await dio.MultipartFile.fromFile(filePath),
      });

      final response = await _apiClient.dio.post(
        '/drivers/upload',
        data: formData,
      );

      final newStatus = _mapStatus(response.data['status']);
      state = state.copyWith(
        isLoading: false,
        profile: state.profile.copyWith(status: newStatus),
      );
    } catch (e) {
      state = state.copyWith(isLoading: false, errorMessage: 'Upload failed');
    }
  }

  void toggleOnline() {
    if (state.profile.status != DriverStatus.approved) return;

    if (state.operationStatus == OperationStatus.offline) {
      state = state.copyWith(operationStatus: OperationStatus.available);
    } else {
      state = state.copyWith(operationStatus: OperationStatus.offline);
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
    );
  }

  // --- Trip Lifecycle ---

  void markArrived() => state = state.copyWith(tripStep: TripStep.arrived);
  
  void startTrip() => state = state.copyWith(tripStep: TripStep.started);

  void completeTrip() {
    if (_socketService == null || state.activeRequest == null) return;

    _socketService!.emit('ride:complete', {
      'rideId': state.activeRequest!.id,
      'passengerId': state.activeRequest!.passengerId,
      'driverId': _userId,
      'totalFare': state.activeRequest!.fare,
      'isCash': state.activeRequest!.isCash,
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
    );
  }

  @override
  void dispose() {
    _countdownTimer?.cancel();
    _heartbeatTimer?.cancel();
    _socketSubscription?.cancel();
    super.dispose();
  }
}

final driverControllerProvider = StateNotifierProvider<DriverController, DriverState>((ref) {
  final socketService = ref.watch(socketServiceProvider);
  final apiClient = ref.watch(apiClientProvider);
  final authState = ref.watch(authControllerProvider);
  
  String userId = 'guest';
  if (authState.status == AuthStatus.authenticated) {
    // In this phase, we assume the token IS the userId or we extract it correctly
    userId = authState.token!; 
  }

  return DriverController(socketService, apiClient, userId);
});
