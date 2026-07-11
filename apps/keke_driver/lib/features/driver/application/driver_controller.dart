import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:dio/dio.dart' as dio;
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:geolocator/geolocator.dart';
import '../../../core/services/location_foreground_task.dart';
import '../domain/chat_message.dart';
import '../domain/driver_profile.dart';
import '../domain/driver_state.dart';
import '../domain/trip_request.dart';
import '../../../core/network/socket_service.dart';
import '../../../core/network/socket_provider.dart';
import '../../../core/network/api_client.dart';
import '../../auth/application/auth_controller.dart';
import '../../auth/domain/auth_state.dart';
import 'driver_finance_controller.dart';
import 'package:jwt_decoder/jwt_decoder.dart';
import '../../../core/network/notification_service.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import '../../../core/services/sound_service.dart';
import '../../../core/config/env_config.dart';

class DriverController extends StateNotifier<DriverState> {
  SocketService? _socketService;
  final ApiClient _apiClient;
  final String _userId;

  Timer? _countdownTimer;
  Timer? _heartbeatTimer;
  Timer? _waitTimer;
  Timer? _watchdogTimer;
  Timer? _errorClearTimer;
  StreamSubscription? _socketSubscription;
  StreamSubscription? _notificationSubscription;
  final NotificationService _notificationService;
  final SoundService _soundService;
  void Function()? _onWalletRefreshNeeded;

  void setWalletRefreshCallback(void Function() cb) => _onWalletRefreshNeeded = cb;

  DriverController(SocketService? initialSocket, this._apiClient, this._notificationService, this._soundService, this._userId)
      : super(DriverState(
          profile: const DriverProfile(status: DriverStatus.unregistered),
          isLoading: true, // hold routing on splash until profile is fetched
        )) {
    _socketService = initialSocket;
    if (_userId != 'guest' && _userId != 'session_invalid') {
      _initDriver();
    } else {
      state = state.copyWith(isLoading: false);
    }
    if (_socketService != null) _listenToSocket();
    _startHeartbeat();
    _listenToNotifications();
  }

  void _listenToNotifications() {
    _notificationSubscription = _notificationService.intentStream.listen((data) {
      print('[DRIVER_SYNC] Notification intent received: $data. Triggering sync...');
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
      
      print('[DRIVER_SIGNAL] Received Event: $event | Payload: $data');
      
      switch (event) {
        case 'ride:request':
          _handleIncomingRequest(data);
          break;
        case 'ride:confirmed':
          // Server-authoritative: DB transaction committed, ride is ours.
          // Moved here from acceptRequest() to prevent optimistic ghost state.
          if (state.activeRequest?.id.toString() == data['rideId']?.toString()) {
            // Join the ride room so chat and broadcast events are received.
            _socketService!.updateActiveRide(data['rideId']?.toString());
            state = state.copyWith(
              tripStep: TripStep.accepted,
              countdown: null,
              clearPickupRoute: true,
              clearRouteEta: true,
            );
            _startWatchdog();
            _fetchPickupRoute(); // fire-and-forget
          }
          break;
        case 'ride:cancelled':
          // Robust comparison: check toString() to avoid type mismatch,
          // or fallback to any active request if payload is the "dismissal" shape
          final incomingRideId = data['rideId']?.toString();
          final currentRideId = state.activeRequest?.id.toString();
          
          if (incomingRideId == currentRideId || state.tripStep == TripStep.none) {
            print('[DRIVER_SIGNAL] Cancellation/Dismissal confirmed for: $incomingRideId');
            _stopWatchdog();
            _resetToAvailable();
          }
          break;
        case 'socket:reconnected':
          print('[DRIVER_SYNC] Socket reconnected. Triggering redundant healing...');
          syncStatus();
          // Re-register presence in Redis immediately — the TTL may have
          // expired while the socket was down, making the driver invisible
          // to dispatch until the next scheduled heartbeat (up to 12s away).
          if (state.operationStatus == OperationStatus.available) {
            _sendHeartbeat();
          }
          break;
        case 'socket:connect_error':
          print('[SOCKET_ERROR] Connection failed: ${data['message']}');
          if (mounted && state.operationStatus == OperationStatus.available) {
            state = state.copyWith(errorMessage: 'Server connection lost — retrying…');
            _scheduleErrorClear(seconds: 8);
          }
          break;
        case 'error:debt_blocked':
          print('[DEBT_BLOCK] Backend rejected cash ride acceptance — debt too high');
          state = state.copyWith(errorMessage: 'Cash ride unavailable — visit Finance to clear your debt.');
          _scheduleErrorClear();
          _resetToAvailable();
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
            _onWalletRefreshNeeded?.call();
          }
          break;
        case 'chat:message':
          try {
            final msg = ChatMessage(
              senderId:   data['senderId']?.toString() ?? '',
              senderRole: data['senderRole']?.toString() ?? 'passenger',
              message:    data['message']?.toString() ?? '',
              timestamp:  DateTime.tryParse(data['timestamp']?.toString() ?? '') ?? DateTime.now(),
            );
            state = state.copyWith(chatMessages: [...state.chatMessages, msg]);
          } catch (e) {
            print('[DRIVER] Failed to parse chat message: $e');
          }
          break;
      }
    });
  }

  void _startHeartbeat() {
    _heartbeatTimer?.cancel();
    _sendHeartbeat();
    _heartbeatTimer = Timer.periodic(const Duration(seconds: 12), (_) => _sendHeartbeat());
  }

  Future<void> _sendHeartbeat() async {
    if (!mounted) return;
    // Send while available OR while on an active ride so the passenger sees live location.
    final isOnline = state.operationStatus == OperationStatus.available ||
        state.operationStatus == OperationStatus.busy;
    if (isOnline && _socketService != null) {
      if (state.profile.status != DriverStatus.approved) return;
      if (!_socketService!.isConnected) {
        print('[HEARTBEAT] Socket not yet connected — will retry on next tick');
      }

      double lat, lng;
      try {
        // Use low accuracy first — it uses cell/WiFi and resolves in <1s on Android.
        // This prevents GPS cold-start timeouts from silently dropping heartbeats.
        final position = await Geolocator.getCurrentPosition(
            desiredAccuracy: LocationAccuracy.low,
            timeLimit: const Duration(seconds: 8));
        lat = position.latitude;
        lng = position.longitude;
      } catch (e) {
        print('[HEARTBEAT] getCurrentPosition failed: $e. Trying last known...');
        try {
          final lastPos = await Geolocator.getLastKnownPosition();
          if (lastPos != null) {
            lat = lastPos.latitude;
            lng = lastPos.longitude;
          } else {
            throw Exception('No last known position');
          }
        } catch (e2) {
          print('[HEARTBEAT] Both location methods failed: $e2');
          if (mounted) {
            state = state.copyWith(errorMessage: 'Location unavailable — move to an open area.');
            _scheduleErrorClear();
          }
          return;
        }
      }
      if (!mounted) return;

      print('[HEARTBEAT] Sending lat: $lat, lng: $lng');
      _socketService!.emit('driver:heartbeat', {
        'driverId': _userId,
        'lat': lat,
        'lng': lng,
      });

      if (mounted) {
        state = state.copyWith(driverCurrentPosition: LatLng(lat, lng));
      }

      // Update live ETA/distance for active trip
      if (state.activeRequest != null && mounted) {
        final driverLoc = LatLng(lat, lng);
        LatLng? target;
        if (state.tripStep == TripStep.accepted) {
          target = state.activeRequest!.pickupLocation;
          if (state.pickupRoute.isEmpty) _fetchPickupRoute();
        } else if (state.tripStep == TripStep.arrived || state.tripStep == TripStep.started) {
          target = state.activeRequest!.destinationLocation;
        }
        if (target != null && mounted) {
          final dist = _haversineDistance(driverLoc, target);
          state = state.copyWith(
            routeEtaMinutes: (dist / 230).clamp(0.0, 999.0),
            routeDistanceMeters: dist,
          );
        }
      }
    }
  }

  void _handleIncomingRequest(Map<String, dynamic> data) {
    if (state.operationStatus != OperationStatus.available) return;

    // Debt gate: suppress cash requests when driver has cash-block-level debt
    final incomingIsCash = data['isCash'] == true;
    if (incomingIsCash && state.profile.debtAmount >= 2000) {
      print('[DEBT_GATE] Suppressed cash request — driver debt ₦${state.profile.debtAmount}');
      state = state.copyWith(
        errorMessage: 'Cash ride unavailable — visit Finance to clear your debt.',
      );
      _scheduleErrorClear();
      return;
    }

    try {
      final pickupLat = (data['pickupLat'] as num?)?.toDouble() ?? 0.0;
      final pickupLng = (data['pickupLng'] as num?)?.toDouble() ?? 0.0;
      final destLat = (data['destinationLat'] as num?)?.toDouble() ?? 0.0;
      final destLng = (data['destinationLng'] as num?)?.toDouble() ?? 0.0;
      final fare = (data['fare'] as num?)?.toDouble() ?? 0.0;

      final request = TripRequest(
        id: data['rideId'],
        passengerId: data['passengerId']?.toString() ?? 'unknown',
        isCash: data['isCash'] == true,
        passengerName: data['passengerName']?.toString() ?? 'Passenger',
        passengerPhone: data['passengerPhone']?.toString(),
        pickupAddress: data['pickupAddress']?.toString() ?? '',
        pickupLocation: LatLng(pickupLat, pickupLng),
        destinationAddress: data['destinationAddress']?.toString() ?? '',
        destinationLocation: LatLng(destLat, destLng),
        fare: fare,
        distance: 0,
        countdownSeconds: 30,
        pickupCode: data['pickupCode']?.toString(),
      );

      state = state.copyWith(
        operationStatus: OperationStatus.busy,
        activeRequest: request,
        countdown: 30,
      );

      _startCountdown();
      _soundService.playRequestSound();
    } catch (e) {
      print('[DRIVER] Failed to parse incoming request: $e');
    }
  }



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

  List<LatLng> _decodePolyline(String encoded) {
    final polyline = <LatLng>[];
    int index = 0;
    final len = encoded.length;
    int lat = 0, lng = 0;
    while (index < len) {
      int b, shift = 0, result = 0;
      do {
        b = encoded.codeUnitAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      lat += ((result & 1) != 0 ? ~(result >> 1) : (result >> 1));
      shift = 0;
      result = 0;
      do {
        b = encoded.codeUnitAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      lng += ((result & 1) != 0 ? ~(result >> 1) : (result >> 1));
      polyline.add(LatLng(lat / 1E5, lng / 1E5));
    }
    return polyline;
  }

  Future<List<LatLng>> _fetchRoutePolyline(LatLng origin, LatLng destination) async {
    final apiKey = EnvConfig.current.googleMapsApiKey;
    if (apiKey.isEmpty) return [];
    try {
      final url = 'https://maps.googleapis.com/maps/api/directions/json'
          '?origin=${origin.latitude},${origin.longitude}'
          '&destination=${destination.latitude},${destination.longitude}'
          '&key=$apiKey';
      final response = await dio.Dio().get(url, options: dio.Options(headers: {
        'X-Ios-Bundle-Identifier': 'ng.kekeride.driver',
        'X-Android-Package': 'ng.kekeride.driver',
      }));
      if (response.data['status'] == 'OK') {
        final encoded = response.data['routes'][0]['overview_polyline']['points'] as String;
        return _decodePolyline(encoded);
      }
    } catch (_) {}
    return [];
  }

  Future<void> _fetchPickupRoute() async {
    if (state.activeRequest == null) return;
    double lat, lng;
    try {
      final pos = await Geolocator.getCurrentPosition(
          desiredAccuracy: LocationAccuracy.low,
          timeLimit: const Duration(seconds: 5));
      lat = pos.latitude;
      lng = pos.longitude;
    } catch (_) {
      final last = await Geolocator.getLastKnownPosition();
      if (last == null) return;
      lat = last.latitude;
      lng = last.longitude;
    }
    final driverLoc = LatLng(lat, lng);
    final points = await _fetchRoutePolyline(driverLoc, state.activeRequest!.pickupLocation);
    if (!mounted || state.tripStep != TripStep.accepted) return;
    final dist = _haversineDistance(driverLoc, state.activeRequest!.pickupLocation);
    state = state.copyWith(
      pickupRoute: points,
      routeEtaMinutes: (dist / 230).clamp(0.0, 999.0),
      routeDistanceMeters: dist,
    );
  }

  Future<void> _fetchDestinationRoute() async {
    if (state.activeRequest == null) return;
    final pickup = state.activeRequest!.pickupLocation;
    final destination = state.activeRequest!.destinationLocation;
    final points = await _fetchRoutePolyline(pickup, destination);
    if (!mounted) return;
    final dist = _haversineDistance(pickup, destination);
    state = state.copyWith(
      destinationRoute: points.isNotEmpty ? points : state.destinationRoute,
      routeEtaMinutes: (dist / 230).clamp(0.0, 999.0),
      routeDistanceMeters: dist,
    );
  }

  int _profileRetries = 0;
  Timer? _profileRetryTimer;

  Future<void> _initDriver() async {
    // Small delay ensures Riverpod state finishes spreading before we hit the network
    await Future.delayed(const Duration(milliseconds: 200));
    if (!mounted) return;

    state = state.copyWith(isLoading: true);
    try {
      final response = await _apiClient.dio.get('/drivers/status/$_userId');
      if (!mounted) return;

      // Defensive: dio normally decodes application/json to a Map, but if the
      // response arrives as a raw String, indexing it with a key would throw
      // and be misread as a load failure. Decode it here.
      var data = response.data;
      if (data is String && data.isNotEmpty) {
        data = jsonDecode(data);
      }
      print('[DRIVER_INIT] Status fetch for $_userId -> ${data is Map ? data['status'] : data.runtimeType}');

      // Successful server response — the status is now authoritative, whatever
      // it is. Reset the retry counter and mark the profile as loaded so the
      // auth guard can route confidently.
      _profileRetries = 0;

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
            photoUrl: data['photoUrl'],
            debtAmount: (data['commissionDebt'] as num?)?.toDouble() ?? 0.0,
            ninVerified: data['ninVerified'] == true,
          ),
          isLoading: false,
          profileLoaded: true,
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
              pickupCode: rideData['pickupCode']?.toString(),
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
          if (mounted) {
            state = state.copyWith(
              errorMessage: 'Could not restore your active ride. Please check your connection.',
            );
          }
        }
      } else {
        // Server confirms this account has no driver profile yet — a genuinely
        // new driver. Safe to route to onboarding.
        state = state.copyWith(isLoading: false, profileLoaded: true);
      }
    } catch (e) {
      if (!mounted) return;
      final detail = _describeFetchError(e);
      print('[DRIVER_INIT] Status fetch FAILED for $_userId: $detail');
      _lastFetchError = detail;
      // Do NOT drop profileLoaded here. Leaving an authenticated driver
      // classified as `unregistered` after a failed fetch would misroute an
      // already-onboarded driver to /onboarding. Retry with backoff; the auth
      // guard holds on /splash while profileLoaded is still false.
      _scheduleProfileRetry();
    }
  }

  String? _lastFetchError;

  /// Builds a human-readable description of a status-fetch failure. Surfaced on
  /// the splash "Try Again" screen so field failures can be diagnosed without a
  /// device log.
  String _describeFetchError(Object e) {
    if (e is dio.DioException) {
      switch (e.type) {
        case dio.DioExceptionType.connectionTimeout:
        case dio.DioExceptionType.sendTimeout:
        case dio.DioExceptionType.receiveTimeout:
          return 'Network timed out. Please check your connection.';
        case dio.DioExceptionType.connectionError:
          return 'Couldn\'t reach the server. Please check your connection.';
        case dio.DioExceptionType.badResponse:
          final code = e.response?.statusCode;
          final body = e.response?.data;
          final serverMsg = body is Map
              ? (body['message']?.toString() ?? body['error']?.toString())
              : null;
          return 'Server error ($code)${serverMsg != null ? ': $serverMsg' : ''}';
        default:
          return 'Couldn\'t load your profile (${e.type.name}).';
      }
    }
    return 'Couldn\'t load your profile: $e';
  }

  /// Manual retry entry point (e.g. from the splash "Try Again" button) after
  /// the automatic retries have been exhausted.
  void retryProfileLoad() {
    _profileRetries = 0;
    _profileRetryTimer?.cancel();
    _initDriver();
  }

  void _scheduleProfileRetry() {
    _profileRetryTimer?.cancel();
    if (_profileRetries >= 5) {
      // Give up after several attempts, but stay unloaded so the guard keeps us
      // on /splash (with an error) rather than wrongly showing onboarding.
      if (mounted) {
        state = state.copyWith(
          isLoading: false,
          errorMessage: _lastFetchError ??
              'Couldn\'t load your driver profile. Please check your connection and try again.',
        );
      }
      return;
    }
    _profileRetries++;
    final delay = Duration(seconds: 2 * _profileRetries);
    print('[DRIVER_INIT] Retrying profile fetch (#$_profileRetries) in ${delay.inSeconds}s');
    _profileRetryTimer = Timer(delay, () {
      if (mounted) _initDriver();
    });
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

  // Removed setDriverStatus (Fake/Local Spoofing blocked)

  // --- Onboarding & Status ---
  
  Future<void> submitOnboarding({
    required String firstName,
    required String lastName,
    required String plate,
    required String model,
    required String nin,
  }) async {
    state = state.copyWith(isLoading: true, errorMessage: null);
    try {
      final response = await _apiClient.dio.post('/drivers/onboarding', data: {
        'userId': _userId,
        'firstName': firstName,
        'lastName': lastName,
        'vehiclePlate': plate,
        'vehicleModel': model,
        'nin': nin,
      });

      if (!mounted) return;

      final rawData = response.data;

      if (rawData == null || rawData is! Map) {
        throw 'Invalid backend response: Expected Map, got ${rawData.runtimeType}';
      }

      final Map<String, dynamic> responseBody = Map<String, dynamic>.from(rawData);
      final newStatusStr = responseBody['status']?.toString() ?? 'pending_documents';
      final newStatus = _mapStatus(newStatusStr);

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
      String msg;
      if (e is dio.DioException) {
        final errData = e.response?.data;
        msg = (errData is Map ? errData['message']?.toString() : null)
            ?? 'We couldn\'t submit your details. Please try again.';
      } else {
        msg = 'We couldn\'t submit your details. Please try again.';
      }
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

      if (rawData == null || rawData is! Map) {
        throw 'Invalid backend response: Expected Map, got ${rawData.runtimeType}';
      }

      final Map<String, dynamic> responseBody = Map<String, dynamic>.from(rawData);
      final newStatusStr = responseBody['status']?.toString() ?? 'pending_documents';
      DriverStatus newStatus = _mapStatus(newStatusStr);
      final filename = responseBody['filename']?.toString() ?? 'uploaded';

      final newProfile = state.profile.copyWith(
          status: newStatus,
          licenseUrl: docType == 'license' ? filename : state.profile.licenseUrl,
          idCardUrl: docType == 'id_card' ? filename : state.profile.idCardUrl,
          vehiclePaperUrl: docType == 'vehicle_paper' ? filename : state.profile.vehiclePaperUrl,
          photoUrl: docType == 'photo' ? filename : state.profile.photoUrl,
      );

      if (newProfile.licenseUrl == null || 
          newProfile.idCardUrl == null || 
          newProfile.vehiclePaperUrl == null || 
          newProfile.photoUrl == null) {
          newStatus = DriverStatus.pendingDocuments;
      } else {
          newStatus = newProfile.status;
      }

      state = state.copyWith(
        profile: newProfile.copyWith(status: newStatus),
      );
    } catch (e) {
      if (!mounted) return;
      String msg;
      if (e is dio.DioException) {
        if (e.response?.statusCode == 413) {
          msg = 'This photo is too large. Please try a clearer, smaller image.';
        } else {
          final errData = e.response?.data;
          msg = (errData is Map ? errData['message']?.toString() : null)
              ?? 'Document upload failed. Please try again.';
        }
      } else {
        msg = 'Document upload failed. Please try again.';
      }
      state = state.copyWith(errorMessage: msg);
    } finally {
      if (mounted) {
        state = state.copyWith(isLoading: false);
      }
    }
  }

  Future<bool> verifyNIN(String nin) async {
    state = state.copyWith(isLoading: true, errorMessage: null);
    try {
      final response = await _apiClient.dio.post('/drivers/verify-nin', data: {
        'nin': nin,
      });

      if (!mounted) return false;

      final data = response.data;
      if (data != null && data['ninVerified'] == true) {
        state = state.copyWith(
          profile: state.profile.copyWith(ninVerified: true),
        );
        return true;
      }
      return false;
    } catch (e) {
      if (!mounted) return false;
      String msg;
      if (e is dio.DioException) {
        final errData = e.response?.data;
        msg = (errData is Map ? errData['message']?.toString() : null)
            ?? 'NIN verification failed. Please try again.';
      } else {
        msg = 'NIN verification failed. Please try again.';
      }
      state = state.copyWith(errorMessage: msg);
      return false;
    } finally {
      if (mounted) {
        state = state.copyWith(isLoading: false);
      }
    }
  }

  void toggleOnline() {
    final p = state.profile;

    // Going OFFLINE is always allowed when currently online.
    if (state.operationStatus != OperationStatus.offline) {
      state = state.copyWith(operationStatus: OperationStatus.offline);
      _heartbeatTimer?.cancel();
      _stopLocationForegroundService();
      if (_socketService != null) {
        _socketService!.emit('driver:offline', {'driverId': _userId});
      }
      return;
    }

    // Going ONLINE — check eligibility and surface the ACCURATE reason.
    // Admin approval is the source of truth. Since there is no external NIMC
    // API yet, admin approval already covers manual NIN review, so we do NOT
    // gate on ninVerified separately.
    switch (p.status) {
      case DriverStatus.approved:
        break; // eligible
      case DriverStatus.pendingApproval:
        state = state.copyWith(errorMessage: 'Your account is still pending admin approval.');
        _scheduleErrorClear();
        return;
      case DriverStatus.rejected:
        state = state.copyWith(errorMessage: 'Your application needs attention. Open your profile to view details.');
        _scheduleErrorClear();
        return;
      case DriverStatus.suspended:
        state = state.copyWith(errorMessage: 'Your account is suspended. Please contact support.');
        _scheduleErrorClear();
        return;
      default: // pendingDocuments / unregistered
        state = state.copyWith(errorMessage: 'Please complete your KYC documents before going online.');
        _scheduleErrorClear();
        return;
    }

    if (p.debtAmount >= 5000) {
      state = state.copyWith(errorMessage: 'Account blocked — visit Finance to clear your debt and go online.');
      _scheduleErrorClear();
      return;
    }

    // Approved and clear — go online.
    state = state.copyWith(operationStatus: OperationStatus.available);
    _startHeartbeat();
    _startLocationForegroundService();
  }

  void _startLocationForegroundService() {
    if (!Platform.isAndroid) return;
    FlutterForegroundTask.startService(
      serviceId: 1001,
      notificationTitle: 'Keke Driver',
      notificationText: 'You are online and available for rides',
      callback: locationTaskCallback,
    ).catchError((_) {});
  }

  void _stopLocationForegroundService() {
    if (!Platform.isAndroid) return;
    FlutterForegroundTask.stopService().catchError((_) {});
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

    // Do NOT optimistically set TripStep.accepted here.
    // ride:confirmed from the server is the sole authority — it handles state and watchdog.
    // Cancel the countdown timer so it freezes; ride:confirmed will clear it.
    _countdownTimer?.cancel();
  }

  void rejectRequest() {
    if (_socketService == null || state.activeRequest == null) return;

    print('[DRIVER_ACTION] Rejecting ride: ${state.activeRequest!.id}');
    _socketService!.emit('ride:reject', {
      'rideId': state.activeRequest!.id,
      'driverId': _userId,
    });

    _resetToAvailable();
  }

  void _resetToAvailable() {
    print('[DRIVER_LIFECYCLE] Resetting to available state.');
    _countdownTimer?.cancel();
    _socketService?.updateActiveRide(null);
    state = state.copyWith(
      operationStatus: OperationStatus.available,
      tripStep: TripStep.none,
      clearActiveRequest: true,
      clearCountdown: true,
      clearPickupRoute: true,
      clearDestinationRoute: true,
      clearRouteEta: true,
    );
    _soundService.stop();
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
    print('[DRIVER_LIFECYCLE] Request timed out.');
    _resetToAvailable();
  }

  // --- Trip Lifecycle ---

  void markArrived() {
    if (_socketService == null || state.activeRequest == null) return;

    _socketService!.emit('ride:arrived', {
      'rideId': state.activeRequest!.id,
      'driverId': _userId,
    });

    state = state.copyWith(
      tripStep: TripStep.arrived,
      waitTimeSeconds: 0,
      clearPickupRoute: true,
      clearRouteEta: true,
    );
    _fetchDestinationRoute(); // fire-and-forget

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

  void sendChatMessage(String message) {
    if (_socketService == null || state.activeRequest == null || message.trim().isEmpty) return;
    _socketService!.emit('chat:send', {
      'rideId':     state.activeRequest!.id,
      'senderId':   _userId,
      'senderRole': 'driver',
      'message':    message.trim(),
    });
  }

  void triggerSos(String reason) {
    if (_socketService == null || state.activeRequest == null) return;
    _socketService!.emit('ride:sos', {
      'rideId': state.activeRequest!.id,
      'initiatorId': _userId,
      'initiatorRole': 'driver',
      'reason': reason,
      'lat': state.driverCurrentPosition?.latitude ?? 0.0,
      'lng': state.driverCurrentPosition?.longitude ?? 0.0,
    });
  }

  void finishAndGoAvailable() {
    _socketService?.updateActiveRide(null);
    state = state.copyWith(
      tripStep: TripStep.none,
      operationStatus: OperationStatus.available,
      waitTimeSeconds: 0,
      clearActiveRequest: true,
      clearCountdown: true,
      chatMessages: [],
      clearPickupRoute: true,
      clearDestinationRoute: true,
      clearRouteEta: true,
    );
    _stopWatchdog();
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

  Future<void> updateVehicleInfo({
    required String plate,
    required String model,
  }) async {
    if (!mounted) return;
    state = state.copyWith(isLoading: true, clearErrorMessage: true);
    try {
      final response = await _apiClient.dio.patch('/drivers/profile', data: {
        'vehiclePlate': plate.trim().toUpperCase(),
        'vehicleModel': model.trim(),
      });
      if (!mounted) return;
      final data = response.data as Map<String, dynamic>;
      state = state.copyWith(
        profile: state.profile.copyWith(
          vehiclePlate: data['vehiclePlate']?.toString() ?? plate,
          vehicleModel: data['vehicleModel']?.toString() ?? model,
        ),
        isLoading: false,
      );
    } catch (e) {
      if (!mounted) return;
      String msg = 'Could not update vehicle info. Please try again.';
      if (e is dio.DioException) {
        final errData = e.response?.data;
        msg = (errData is Map ? errData['message']?.toString() : null) ?? msg;
      }
      state = state.copyWith(isLoading: false, errorMessage: msg);
    }
  }

  Future<void> refreshDriverStatus() async {
    if (!mounted) return;
    state = state.copyWith(isLoading: true, clearErrorMessage: true);
    try {
      final response = await _apiClient.dio.get('/drivers/status/$_userId');
      if (!mounted) return;
      final data = response.data;
      if (data != null && data['status'] != null) {
        final newStatus = _mapStatus(data['status'].toString());
        state = state.copyWith(
          profile: state.profile.copyWith(
            status: newStatus,
            firstName: data['firstName']?.toString() ?? state.profile.firstName,
            lastName: data['lastName']?.toString() ?? state.profile.lastName,
            vehiclePlate: data['vehiclePlate']?.toString() ?? state.profile.vehiclePlate,
            vehicleModel: data['vehicleModel']?.toString() ?? state.profile.vehicleModel,
            licenseUrl: data['licenseUrl']?.toString(),
            idCardUrl: data['idCardUrl']?.toString(),
            vehiclePaperUrl: data['vehiclePaperUrl']?.toString(),
            photoUrl: data['photoUrl']?.toString(),
            debtAmount: (data['commissionDebt'] as num?)?.toDouble() ?? state.profile.debtAmount,
          ),
          isLoading: false,
          profileLoaded: true,
        );
      } else {
        state = state.copyWith(isLoading: false);
      }
    } catch (e) {
      if (!mounted) return;
      state = state.copyWith(
        isLoading: false,
        errorMessage: 'Could not reach the server. Check your connection and try again.',
      );
    }
  }

  Future<void> syncStatus() async {
    try {
      final response = await _apiClient.dio.get('/rides/active/driver');
      final data = response.data;
      
      if (data != null && data['rideId'] != null) {
        final status = data['status'];
        print('[DRIVER_SYNC] Redundant healing caught status: $status');
        
        // If we don't have the request in memory, perform full recovery
        if (state.activeRequest == null) {
           print('[DRIVER_SYNC] Recovering active ride into memory...');
           // Re-trigger the init logic which handles recovery
           _initDriver();
           return;
        }

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
    _errorClearTimer?.cancel();
    _profileRetryTimer?.cancel();
    _socketSubscription?.cancel();
    _notificationSubscription?.cancel();
    super.dispose();
  }
}

final driverControllerProvider = StateNotifierProvider<DriverController, DriverState>((ref) {
  final apiClient = ref.watch(apiClientProvider);
  final authState = ref.watch(authControllerProvider);
  
  final socketService = ref.read(socketServiceProvider);
  final notificationService = ref.read(notificationServiceProvider('driver'));
  final soundService = ref.read(soundServiceProvider);

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
      return DriverController(null, apiClient, notificationService, soundService, 'session_invalid');
    }
  }

  final controller = DriverController(socketService, apiClient, notificationService, soundService, userId);

  controller.setWalletRefreshCallback(
    () => ref.read(driverFinanceControllerProvider.notifier).refresh(),
  );

  // Listen for socket updates without re-creating the controller
  ref.listen(socketServiceProvider, (previous, next) {
    controller.updateSocketService(next);
  });

  return controller;
});
