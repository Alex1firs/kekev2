import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:dio/dio.dart' as dio;
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:geolocator/geolocator.dart';
import 'package:package_info_plus/package_info_plus.dart';
import '../../../core/services/location_foreground_task.dart';
import '../../../core/services/battery_optimization_service.dart';
import '../../../core/services/reliability_log.dart';
import '../../../core/services/driver_readiness_service.dart';
import '../../../core/storage/secure_storage.dart';
import '../domain/chat_message.dart';
import '../domain/driver_profile.dart';
import '../domain/driver_state.dart';
import '../domain/trip_request.dart';
import 'active_ride_recovery.dart';
import '../domain/ride_coordination.dart';
import '../../../core/services/analytics_service.dart';
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

class DriverController extends StateNotifier<DriverState> with WidgetsBindingObserver {
  SocketService? _socketService;
  final ApiClient _apiClient;
  final String _userId;
  final SecureStorageService _storage;
  /// Auth token, handed to the foreground-service isolate so it can post the
  /// HTTP heartbeat with a Bearer header while the app UI is suspended.
  final String? _authToken;
  bool _autoResumeAttempted = false;

  Timer? _countdownTimer;
  Timer? _heartbeatTimer;
  Timer? _waitTimer;
  Timer? _watchdogTimer;
  Timer? _errorClearTimer;
  StreamSubscription? _socketSubscription;

  /// Wall-clock time the current pending offer arrived. Used to expire a stale
  /// offer whose 1-second countdown froze while the app was backgrounded
  /// (Dart timers pause in the background, so the countdown alone can't be
  /// trusted to reset the offer).
  DateTime? _offerReceivedAt;
  StreamSubscription? _notificationSubscription;
  final NotificationService _notificationService;
  final SoundService _soundService;
  final AnalyticsService _analytics;
  void Function()? _onWalletRefreshNeeded;

  void setWalletRefreshCallback(void Function() cb) => _onWalletRefreshNeeded = cb;

  DriverController(SocketService? initialSocket, this._apiClient, this._notificationService, this._soundService, this._userId, this._storage, this._authToken, {AnalyticsService? analytics})
      : _analytics = analytics ?? AnalyticsService(),
        super(DriverState(
          profile: const DriverProfile(status: DriverStatus.unregistered),
          isLoading: true, // hold routing on splash until profile is fetched
        )) {
    _socketService = initialSocket;
    if (_userId != 'guest' && _userId != 'session_invalid') {
      /*
       * Recovery is NOT nested inside the profile fetch.
       *
       * It used to be, and a profile fetch that failed — a slow network, a 500,
       * anything — meant no ride recovery at all. A driver mid-trip whose app
       * restarted on a bad connection lost the ride entirely, because the code
       * that would have restored it lived inside the success branch of an
       * unrelated request.
       *
       * The two are independent questions: "who is this driver" and "is this
       * driver on a ride". They are now asked independently.
       */
      recoverActiveRide(DriverRecoverySource.coldStart);
      _initDriver();
    } else {
      state = state.copyWith(isLoading: false);
    }
    if (_socketService != null) _listenToSocket();
    _startHeartbeat();

    /*
     * Keep the persistent notification in step with the trip, from one place.
     * It previously said "KekeRide is online / Sharing location for ride
     * requests" for the entire journey, which tells a driver nothing about the
     * ride they are on and nothing a passenger-facing screenshot could confirm.
     */
    addListener((_) => _syncForegroundNotification(), fireImmediately: false);
    _listenToNotifications();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState lifecycleState) {
    if (lifecycleState == AppLifecycleState.resumed) {
      onAppResumed();
    }
  }

  /// Called when the app returns to the foreground (e.g. the driver taps a
  /// "New Ride Request" push on the lock screen). iOS/Android drop the socket
  /// while backgrounded, so we force a reconnect immediately. On reconnect the
  /// socket re-emits `join`, which makes the server re-deliver any ride offer
  /// that was missed while we were disconnected; syncStatus() heals any
  /// already-accepted ride, and a heartbeat re-asserts presence for dispatch.
  void onAppResumed() {
    if (!mounted) return;
    print('[LIFECYCLE] App resumed — forcing socket reconnect + sync.');
    _socketService?.reconnect();
    syncStatus(source: DriverRecoverySource.appResume);
    if (state.operationStatus == OperationStatus.available) {
      _sendHeartbeat();
      _refreshBatteryWarning();
    }
  }

  void _listenToNotifications() {
    _notificationSubscription = _notificationService.intentStream.listen((data) {
      print('[DRIVER_SYNC] Notification intent received: $data. Verifying with server...');
      // The payload is a hint. The ride may have moved on — or been cancelled —
      // between the push being sent and the driver tapping it.
      syncStatus(source: DriverRecoverySource.notificationTap);

      // A coordination push and the socket event that accompanies it describe the
      // SAME question. The server sends a matching `eventId` on both, so marking
      // it seen here means whichever arrives second raises no second prompt.
      final type = data['type']?.toString();
      const coordinationTypes = {
        'STALE_RIDE_WARNING',
        'STALE_RIDE_DECISION',
        'CANCELLATION_REQUESTED',
        'RIDE_ESCALATED',
      };
      if (!coordinationTypes.contains(type)) return;

      final eventId = data['eventId']?.toString();
      if (eventId != null && eventId.isNotEmpty) {
        if (_rememberCoordinationEvent(eventId)) {
          _analytics.logCoordination('notification_displayed',
              rideId: data['rideId']?.toString(),
              eventId: eventId,
              stage: 'notification',
              extra: {'type': type});
        }
      }
      // Tapping the notification must land on the real state, not on whatever the
      // push text said a moment ago — it may already have been answered.
      refreshCoordination();
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
            _handleRideCancelled(data);
          }
          break;
        case 'socket:reconnected':
          print('[DRIVER_SYNC] Socket reconnected. Triggering redundant healing...');
          if (mounted) state = state.copyWith(connectionStatus: ConnectionStatus.connected);
          syncStatus();
          // Re-register presence in Redis immediately — the TTL may have
          // expired while the socket was down, making the driver invisible
          // to dispatch until the next scheduled heartbeat (up to 12s away).
          if (state.operationStatus == OperationStatus.available) {
            _sendHeartbeat();
          }
          // Any prompt we were showing may have been answered or expired while we
          // were offline. Only the server knows; re-read rather than guess.
          refreshCoordination();
          break;
        case 'socket:disconnected':
          print('[SOCKET] Disconnected.');
          if (mounted) state = state.copyWith(connectionStatus: ConnectionStatus.disconnected);
          break;
        case 'socket:connect_error':
          print('[SOCKET_ERROR] Connection failed: ${data['message']}');
          if (mounted && state.operationStatus == OperationStatus.available) {
            state = state.copyWith(
              connectionStatus: ConnectionStatus.connecting,
              errorMessage: 'Server connection lost — retrying…',
            );
            _scheduleErrorClear(seconds: 8);
          } else if (mounted) {
            state = state.copyWith(connectionStatus: ConnectionStatus.connecting);
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
        case 'ride:awaiting_confirmation':
          print('[DRIVER] Far from destination — awaiting passenger early-end confirmation.');
          state = state.copyWith(
            awaitingEarlyEndConfirmation: true,
            errorMessage: data['message']?.toString() ??
                "You're far from the booked destination — waiting for the passenger to confirm the drop-off.",
          );
          break;
        case 'ride:early_end_held':
          print('[DRIVER] Early-end resolved: payment held for review.');
          _stopWatchdog();
          finishAndGoAvailable();
          _onWalletRefreshNeeded?.call();
          state = state.copyWith(errorMessage: 'Trip completed. Payment is under review.');
          _scheduleErrorClear(seconds: 8);
          break;
        // ── Delayed-ride coordination ─────────────────────────────────────
        // A delay is a conversation, not a failure. All of these route through
        // one path so the dedupe rule cannot diverge between event types.
        case 'ride:delay_notice':
        case 'ride:delay_update':
        case 'ride:stale_decision_required':
        case 'ride:cancel_requested':
        case 'ride:delay_escalated':
          _applyCoordinationEvent(data);
          break;
        case 'ride:stale_decision_resolved':
          _onCoordinationResolved(
            data,
            title: data['message']?.toString() ?? 'The passenger is still waiting',
            body: 'Please head to the pickup point.',
          );
          break;
        case 'ride:cancel_declined':
          _onCoordinationResolved(
            data,
            title: data['title']?.toString() ?? 'The passenger is continuing',
            body: data['body']?.toString() ?? 'They would like to keep the ride.',
          );
          break;
        case 'ride:extension_granted':
          // Our own "I'm still coming" landed. Settle the card calmly rather than
          // leaving the driver looking at a spinner.
          _onExtensionGranted(data);
          break;
        case 'ride:activity_seen':
          _onActivitySeen(data);
          break;
        case 'ride:cancel_request_ack':
          _onCancelRequestAck(data);
          break;
        case 'ride:cancel_response_ack':
        case 'ride:stale_decision_ack':
          _onCoordinationAck(data);
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
        state = state.copyWith(
          driverCurrentPosition: LatLng(lat, lng),
          lastHeartbeatAt: DateTime.now(),
        );
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
    // Refuse a new offer only when the driver is genuinely unavailable —
    // offline, or already committed to an active trip. A lingering `busy` with
    // no trip in progress (e.g. a previous offer whose 30s countdown froze
    // while the app was backgrounded, then was never reset) must NOT keep
    // swallowing new requests: replace the stale offer with this fresh one.
    // Without this the driver still heartbeats (stays on the passenger's map)
    // yet silently drops every incoming request.
    final onActiveTrip = state.tripStep == TripStep.accepted ||
        state.tripStep == TripStep.arrived ||
        state.tripStep == TripStep.started;
    if (state.operationStatus == OperationStatus.offline || onActiveTrip) return;

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

      _offerReceivedAt = DateTime.now();
      state = state.copyWith(
        operationStatus: OperationStatus.busy,
        activeRequest: request,
        countdown: 30,
      );

      // Tell the server this offer actually reached the device and is now on
      // screen. Dispatch uses it as delivery evidence — a socket emit that the
      // transport accepted is not proof the driver ever saw the request.
      _socketService?.emit('ride:offer_ack', {
        'rideId': request.id,
        'driverId': _userId,
      });

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
            rating: (data['rating'] as num?)?.toDouble() ?? 0.0,
            ratingCount: (data['ratingCount'] as num?)?.toInt() ?? 0,
          ),
          isLoading: false,
          profileLoaded: true,
        );

        /*
         * Active-ride recovery is started from the constructor, independently
         * of this fetch — see the note there. Awaited here only so that
         * _maybeAutoResumeOnline() below cannot run before the ride question is
         * settled.
         */
        while (_recoveryInFlight) {
          await Future<void>.delayed(const Duration(milliseconds: 20));
        }

        // Auto-resume Online if the driver had chosen to stay online and isn't
        // already mid-ride (recovery above would have set busy).
        await _maybeAutoResumeOnline();
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
      _storage.writeOnlineIntent(false); // don't auto-resume next launch
      state = state.copyWith(
        operationStatus: OperationStatus.offline,
        batteryOptimizationActive: false,
      );
      _heartbeatTimer?.cancel();
      _stopLocationForegroundService();
      ReliabilityLog.log(RelEvent.offlineStopped, {'by': 'toggle'});
      if (_socketService != null) {
        _socketService!.emit('driver:offline', {'driverId': _userId});
      }
      // Declare it over HTTP as well. The socket may be down at exactly the
      // moment a driver stops work, and going offline must not depend on it.
      _declarePresence(false, reason: 'driver toggled offline');
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

    // Approved and clear — remember the choice and go online.
    _storage.writeOnlineIntent(true); // auto-resume on next launch/reconnect
    _goOnlineInternal();
  }

  /// Shared "become available" path used by both the manual toggle and the
  /// startup auto-resume. Assumes eligibility has already been checked.
  void _goOnlineInternal() {
    state = state.copyWith(
      operationStatus: OperationStatus.available,
      connectionStatus: _socketService?.isConnected == true
          ? ConnectionStatus.connected
          : ConnectionStatus.connecting,
    );
    _startHeartbeat();
    _startLocationForegroundService(); // async fire-and-forget
    _declarePresence(true, reason: 'driver toggled online');
    _refreshBatteryWarning();
  }

  /// Tell the server whether this driver is working.
  ///
  /// Fire-and-forget: the heartbeat carries the same declaration, so a failed
  /// call here costs nothing and must never block or fail the toggle the
  /// driver just made. Going online has to feel instant even on a bad
  /// connection.
  void _declarePresence(bool online, {String? reason}) {
    unawaited(() async {
      try {
        await _apiClient.dio.post('/drivers/presence', data: {
          'state': online ? 'ONLINE' : 'OFFLINE',
          if (reason != null) 'reason': reason,
        });
      } catch (_) {
        // Silent by design. The next heartbeat re-asserts ONLINE, and an
        // OFFLINE that failed to post is re-sent when the app next starts.
      }
    }());
  }

  /// Restores Online after an app restart / process kill if the driver had
  /// chosen to stay online — so they never have to re-toggle. Runs once, and
  /// only when the driver is genuinely eligible AND location is usable (we
  /// never fake "Online" without a working location source).

  // ═══════════════════════════════════════════════════════════════════
  //  Active-ride recovery — the single authoritative path
  // ═══════════════════════════════════════════════════════════════════

  DriverActiveRideRecoveryService? _recoveryService;
  bool _recoveryInFlight = false;
  Timer? _recoveryRetryTimer;

  /// True until the first recovery attempt resolves.
  ///
  /// Going Online is blocked while this holds. A driver who is secretly still
  /// on a ride must not advertise themselves as available — the server would
  /// refuse to dispatch to them anyway (DriverEligibilityService excludes
  /// `already_on_active_ride`), so the only thing an optimistic Online achieves
  /// is a driver who believes they are working and receives nothing.
  bool _activeRideUnresolved = true;
  bool get activeRideUnresolved => _activeRideUnresolved;

  DriverActiveRideRecoveryService get _recovery =>
      _recoveryService ??= DriverActiveRideRecoveryService(
        _apiClient.dio,
        log: (event, params) => print('[DRIVER_RECOVERY] $event $params'),
      );

  /// Ask the server whether this driver is on a ride, and make the app agree.
  ///
  /// Every trigger funnels through here: cold start, resume, socket reconnect,
  /// network reconnect, notification tap, and the guard in front of Go Online.
  Future<DriverRecoveryResult> recoverActiveRide(DriverRecoverySource source) async {
    if (_recoveryInFlight) {
      return const DriverRecoveryResult(
          DriverRecoveryOutcome.failed, error: 'in_flight');
    }
    _recoveryInFlight = true;
    try {
      final result = await _recovery.fetch(source: source);
      if (!mounted) return result;

      switch (result.outcome) {
        case DriverRecoveryOutcome.found:
          _applyRecoveredRide(result.snapshot!, source);
          _activeRideUnresolved = false;
          _recoveryRetryTimer?.cancel();
          break;

        case DriverRecoveryOutcome.none:
          _activeRideUnresolved = false;
          _recoveryRetryTimer?.cancel();
          /*
           * "No active ride" does NOT mean "nothing on screen is real".
           *
           * A pending offer the driver has not accepted yet is still
           * `searching` server-side and is invisible to /rides/active/driver.
           * Clearing on a null here would wipe a freshly-arrived offer — the
           * driver hears the alert and no screen appears. That race is why the
           * three cases below are distinguished rather than collapsed.
           */
          if (state.tripStep != TripStep.none) {
            // We believed we were on an accepted trip; the server says we are
            // not. It ended while we were away.
            _clearRecoveredRide();
          } else if (state.activeRequest != null &&
              _offerReceivedAt != null &&
              DateTime.now().difference(_offerReceivedAt!) >
                  const Duration(seconds: 40)) {
            // A pending offer past its 30s lifetime: its countdown froze while
            // backgrounded and it can never be accepted. Clear it so the driver
            // returns to `available` and can receive new requests.
            print('[DRIVER_SYNC] Clearing stale pending offer.');
            _resetToAvailable();
          }
          // Otherwise: a fresh pending offer. Leave it alone.
          break;

        case DriverRecoveryOutcome.failed:
          /*
           * Could not ask. Stay unresolved: Go Online remains blocked and the
           * current screen is left alone. The old code showed an error banner
           * and left the driver `offline`, which auto-resume then read as
           * "free to go Online".
           */
          /*
           * Deliberately silent. Writing errorMessage here clobbered more
           * specific messages the driver was already reading — a refused
           * coordination answer, a debt warning — with a generic reconnect
           * notice about a background check they never asked for.
           *
           * The consequence that matters is already covered: staying
           * unresolved keeps Go Online blocked, and _maybeAutoResumeOnline()
           * surfaces its own message at the moment it actually matters.
           */
          _scheduleRecoveryRetry();
          break;
      }
      return result;
    } finally {
      _recoveryInFlight = false;
    }
  }

  void _applyRecoveredRide(
      DriverActiveRideSnapshot snap, DriverRecoverySource source) {
    final previousStep = state.tripStep;
    final previousId = state.activeRequest?.id;

    RideCoordination? coordination;
    if (snap.coordination != null && snap.step == TripStep.accepted) {
      coordination = RideCoordination.fromWire(snap.coordination!, role: 'driver');
      if (coordination != null) {
        _rememberCoordinationEvent(coordination.eventId);
        coordination = coordination.copyWith(
          answered: !coordination.decisionOpen && coordination.decidedByMe,
        );
      }
    }

    state = state.copyWith(
      operationStatus: OperationStatus.busy,
      tripStep: snap.step,
      activeRequest: snap.request,
      coordination: coordination,
      clearErrorMessage: true,
    );

    /*
     * Join the ride room. The old recovery never did, so a restarted driver
     * received no passenger chat, no cancellation broadcast and no coordination
     * event for the rest of the trip — the socket was in the driver room only.
     */
    _socketService?.updateActiveRide(snap.request.id);
    _startWatchdog();

    if (previousId == snap.request.id && previousStep != snap.step) {
      print('[DRIVER_RECOVERY] active_ride_recovery_reconciled '
          '${{'from': previousStep.name, 'to': snap.step.name}}');
    }
  }

  /// The ride ended while we were away. Idempotent.
  ///
  /// Delegates to the existing teardown so there is one definition of "this
  /// driver is free again" — it already clears the request, the coordination
  /// card, the socket ride room and the watchdog.
  void _clearRecoveredRide() {
    _stopWatchdog();
    finishAndGoAvailable();
  }

  void _scheduleRecoveryRetry() {
    _recoveryRetryTimer?.cancel();
    _recoveryRetryTimer = Timer(const Duration(seconds: 4), () {
      if (!mounted || !_activeRideUnresolved) return;
      recoverActiveRide(DriverRecoverySource.manualRetry);
    });
  }

  Future<void> onNetworkRestored() =>
      recoverActiveRide(DriverRecoverySource.networkReconnect);


  // ═══════════════════════════════════════════════════════════════════
  //  Foreground-service notification text
  // ═══════════════════════════════════════════════════════════════════

  /// What the persistent notification should say for a driver state.
  ///
  /// Pure and public so the wording — the part a driver reads on a lock screen
  /// while carrying a passenger — is testable without a platform channel.
  ///
  /// Reuses the EXISTING foreground service rather than posting a second
  /// notification. The service is already required and already justified: the
  /// driver app shares location for dispatch, which is genuine background work.
  /// A second entry for the same ride would be noise.
  @visibleForTesting
  static ({String title, String text}) foregroundCopy(
    OperationStatus status,
    TripStep step, {
    String? pickupAddress,
    String? destinationAddress,
  }) {
    String to(String? v) => (v != null && v.trim().isNotEmpty) ? v.trim() : 'your destination';
    String at(String? v) => (v != null && v.trim().isNotEmpty) ? v.trim() : 'the pickup point';

    if (status == OperationStatus.busy) {
      switch (step) {
        case TripStep.accepted:
          return (title: 'On the way to pick up', text: 'Heading to ${at(pickupAddress)}.');
        case TripStep.arrived:
          return (title: 'Waiting at pickup', text: 'Your passenger has been told you are here.');
        case TripStep.started:
          return (title: 'Trip in progress', text: 'Driving to ${to(destinationAddress)}.');
        case TripStep.none:
        case TripStep.completed:
          break;
      }
    }
    // Online but not on a trip — the original text, which is accurate then.
    return (
      title: 'KekeRide is online',
      text: 'Sharing location for ride requests.',
    );
  }

  /// Keep the foreground notification in step with the trip.
  ///
  /// Called from one listener so no state path can forget it. Failures are
  /// swallowed: the service may not be running (driver offline), and a
  /// notification update must never disturb a ride.
  Future<void> _syncForegroundNotification() async {
    final copy = foregroundCopy(
      state.operationStatus,
      state.tripStep,
      pickupAddress: state.activeRequest?.pickupAddress,
      destinationAddress: state.activeRequest?.destinationAddress,
    );
    final key = '${copy.title}|${copy.text}';
    if (key == _foregroundCopyKey) return;
    _foregroundCopyKey = key;

    try {
      if (!await FlutterForegroundTask.isRunningService) return;
      await FlutterForegroundTask.updateService(
        notificationTitle: copy.title,
        notificationText: copy.text,
      );
    } catch (_) {
      // Offline, or the platform refused. The ride is unaffected.
    }
  }

  String? _foregroundCopyKey;

  Future<void> _maybeAutoResumeOnline() async {
    if (_autoResumeAttempted) return;
    _autoResumeAttempted = true;
    if (!mounted) return;
    /*
     * Never resume Online while we do not know whether this driver is on a
     * ride. A failed recovery used to leave operationStatus `offline`, which
     * this method read as "free" and acted on — putting a driver who was still
     * carrying a passenger back into the available pool.
     */
    if (_activeRideUnresolved) {
      state = state.copyWith(
        errorMessage: 'Checking for an active ride before going Online…',
      );
      return;
    }
    if (state.operationStatus != OperationStatus.offline) return; // already on a ride
    if (state.profile.status != DriverStatus.approved) return;
    if (state.profile.debtAmount >= 5000) return;

    final wantsOnline = await _storage.readOnlineIntent();
    if (!wantsOnline || !mounted) return;

    try {
      final perm = await Geolocator.checkPermission();
      final granted = perm == LocationPermission.always ||
          perm == LocationPermission.whileInUse;
      final serviceOn = await Geolocator.isLocationServiceEnabled();
      if (!granted || !serviceOn) {
        // Don't silently claim Online — nudge the driver to tap Online so the
        // permission/GPS prompts can run.
        if (mounted) {
          state = state.copyWith(errorMessage: 'Tap Online to resume — location access is needed.');
          _scheduleErrorClear(seconds: 6);
        }
        return;
      }
    } catch (_) {
      return;
    }

    if (!mounted) return;
    print('[AUTO_RESUME] Restoring Online from saved intent.');
    _goOnlineInternal();
  }

  Future<void> _refreshBatteryWarning() async {
    try {
      final active = await BatteryOptimizationService.isOptimizationActive();
      if (mounted) state = state.copyWith(batteryOptimizationActive: active);
    } catch (_) {}
  }

  /// Publish the heartbeat credentials to the cross-isolate store.
  ///
  /// BOTH platforms, deliberately. On Android the foreground-service isolate
  /// reads them; on iOS the FCM background isolate does, when it answers a
  /// PRESENCE_WAKE. This used to live inside the Android-only branch below,
  /// which is why an iOS device woken by the server had no credentials to
  /// answer with and stayed silently unreachable.
  Future<void> _publishHeartbeatContext() async {
    final token = _authToken;
    if (token == null) return;
    try {
      await FlutterForegroundTask.saveData(key: kHbUrlKey, value: EnvConfig.current.apiBaseUrl);
      await FlutterForegroundTask.saveData(key: kHbTokenKey, value: token);
      await FlutterForegroundTask.saveData(key: kHbUserKey, value: _userId);
      try {
        final info = await PackageInfo.fromPlatform();
        await FlutterForegroundTask.saveData(
            key: kHbAppVersionKey, value: '${info.version}+${info.buildNumber}');
      } catch (_) {}
    } catch (_) {}
  }

  Future<void> _startLocationForegroundService() async {
    // Credentials first, on every platform — the wake path needs them even
    // where there is no foreground service to start.
    await _publishHeartbeatContext();
    if (!Platform.isAndroid) return;
    // Ensure background location ("Allow all the time") so the service isolate
    // can fetch a fix while the app is backgrounded/locked. Best-effort — the
    // service still works whileInUse when the FGS is running, but 'always' is
    // the reliable setting; we escalate and log the outcome.
    await _ensureBackgroundLocation();
    // Android 13+ needs runtime notification permission for the foreground
    // service to show its persistent notification (and stay reliable).
    try {
      final perm = await FlutterForegroundTask.checkNotificationPermission();
      if (perm != NotificationPermission.granted) {
        await FlutterForegroundTask.requestNotificationPermission();
      }
    } catch (_) {}
    try {
      // Reuse the running service (idempotent go-online / auto-resume) instead
      // of stacking a second start.
      if (await FlutterForegroundTask.isRunningService) {
        await FlutterForegroundTask.restartService();
        ReliabilityLog.log(RelEvent.fgsRestarted, {'reason': 'go_online'});
      } else {
        // Shared with the wake path, so the service the background isolate
        // restarts is configured identically to the one the toggle starts.
        await startLocationHeartbeatService();
        ReliabilityLog.log(RelEvent.fgsStarted, {'starter': 'go_online'});
      }
    } catch (e) {
      ReliabilityLog.log(RelEvent.fgsInterrupted, {'phase': 'start', 'error': e.toString()});
    }
  }

  /// Escalate location permission toward "Allow all the time" (background).
  /// Android 10 grants `always` directly from requestPermission; 11+ needs a
  /// second request that routes the user to the background-location setting.
  Future<void> _ensureBackgroundLocation() async {
    if (!Platform.isAndroid) return;
    try {
      var perm = await Geolocator.checkPermission();
      if (perm == LocationPermission.denied) {
        perm = await Geolocator.requestPermission();
      }
      if (perm == LocationPermission.whileInUse) {
        // Ask again to prompt for background ("all the time") where supported.
        perm = await Geolocator.requestPermission();
      }
      if (perm == LocationPermission.always) {
        ReliabilityLog.log(RelEvent.backgroundLocationGranted, {});
      } else {
        ReliabilityLog.log(RelEvent.backgroundLocationMissing, {'perm': perm.name});
      }
    } catch (e) {
      ReliabilityLog.log(RelEvent.backgroundLocationMissing, {'error': e.toString()});
    }
  }

  Future<void> _stopLocationForegroundService() async {
    if (!Platform.isAndroid) return;
    try {
      await FlutterForegroundTask.stopService();
      ReliabilityLog.log(RelEvent.fgsStopped, {'isolate': 'ui'});
    } catch (e) {
      ReliabilityLog.log(RelEvent.fgsInterrupted, {'phase': 'stop', 'error': e.toString()});
    }
  }

  // --- Real Request Flow ---

  void acceptRequest() {
    if (_socketService == null || state.activeRequest == null) return;

    // Stop the ringing immediately on tap (reject/timeout/cancel stop via
    // _resetToAvailable); acceptance is confirmed asynchronously by the server.
    _soundService.stop();

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
    _offerReceivedAt = null;
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

  /// Test seam: place the controller on an accepted ride without going through
  /// the offer/countdown flow, which needs a live socket and real timers.
  ///
  /// Only the fields the coordination flow reads are set — this is not a
  /// substitute for the real acceptance path.
  /// Place a PENDING offer — one the driver has not accepted.
  ///
  /// Distinct from [debugSetActiveRide]: an unaccepted offer leaves tripStep at
  /// `none` and the ride is still `searching` server-side, so it is invisible to
  /// /rides/active/driver. That difference is what the stale-offer handling in
  /// [recoverActiveRide] turns on, and it needs to be reachable from a test.
  @visibleForTesting
  void debugSetOffer(TripRequest request, {DateTime? receivedAt}) {
    _offerReceivedAt = receivedAt ?? DateTime.now();
    state = state.copyWith(
      activeRequest: request,
      tripStep: TripStep.none,
      isLoading: false,
    );
  }

  @visibleForTesting
  void debugSetActiveRide(TripRequest request, TripStep step) {
    state = state.copyWith(
      activeRequest: request,
      tripStep: step,
      operationStatus: OperationStatus.busy,
      isLoading: false,
    );
  }

  // ── Delayed-ride coordination ──────────────────────────────────────────
  //
  // The driver's half of the human-centred recovery model. Being late is not a
  // failing — traffic, checkpoints, rain and locked gates are the job — so the app
  // asks rather than accuses, and reports what the driver chooses.

  /// Coordination moments already shown. Keyed on the server's deterministic
  /// `eventId`, so a socket event and its push notification are one prompt, and a
  /// replay after reconnect cannot ask twice.
  final Set<String> _seenCoordinationEvents = <String>{};
  static const int _maxRememberedCoordinationEvents = 64;

  bool _rememberCoordinationEvent(String eventId) {
    if (_seenCoordinationEvents.contains(eventId)) return false;
    if (_seenCoordinationEvents.length >= _maxRememberedCoordinationEvents) {
      _seenCoordinationEvents.remove(_seenCoordinationEvents.first);
    }
    _seenCoordinationEvents.add(eventId);
    return true;
  }

  String? get _activeRideId => state.activeRequest?.id.toString();

  /// Apply an inbound coordination event, if it is about the ride we are actually
  /// on and the trip has not already started.
  void _applyCoordinationEvent(Map<String, dynamic> data) {
    final rideId = data['rideId']?.toString();
    if (rideId == null || rideId != _activeRideId) return;
    if (state.tripStep == TripStep.started ||
        state.tripStep == TripStep.completed) {
      return;
    }

    final parsed = RideCoordination.fromWire(data, role: 'driver');
    if (parsed == null) return;

    final fresh = _rememberCoordinationEvent(parsed.eventId);
    if (!fresh && state.coordination?.eventId == parsed.eventId) return;

    state = state.copyWith(coordination: parsed, clearClosure: true);
    if (fresh) {
      _analytics.logCoordination('prompt_displayed',
          rideId: rideId,
          eventId: parsed.eventId,
          stage: parsed.stage.wire,
          extra: {
            'needsAnswer': parsed.needsAnswer,
            'rideStatus': parsed.rideStatus,
            'reasonCode': parsed.reasonCode,
          });
      // Only a real question earns a sound. A driver riding through traffic does
      // not need a chime for every status update.
      if (parsed.needsAnswer) _soundService.playRequestSound();
    }
  }

  void _onCoordinationResolved(
    Map<String, dynamic> data, {
    required String title,
    required String body,
  }) {
    final rideId = data['rideId']?.toString();
    if (rideId == null || rideId != _activeRideId) return;
    final existing = state.coordination;
    state = state.copyWith(
      coordination: RideCoordination(
        rideId: rideId,
        stage: CoordinationStage.confirmedEnRoute,
        title: title,
        body: body,
        eventId: data['eventId']?.toString() ?? '$rideId:resolved',
        rideStatus: existing?.rideStatus ?? 'accepted',
        decisionOpen: false,
        extensionsRemaining: existing?.extensionsRemaining ?? 0,
        actions: const [
          CoordinationAction.callOtherParty,
          CoordinationAction.openNavigation,
          CoordinationAction.requestCancel,
        ],
      ),
    );
  }

  /// Our own "I'm still coming" was granted. The card stays — the ride is still
  /// delayed and the passenger is still waiting — but it goes calm and states
  /// plainly that the passenger was told.
  void _onExtensionGranted(Map<String, dynamic> data) {
    final rideId = data['rideId']?.toString();
    if (rideId == null || rideId != _activeRideId) return;
    final current = state.coordination;
    if (current == null) return;
    state = state.copyWith(
      coordination: current.copyWith(
        stage: CoordinationStage.confirmedEnRoute,
        title: 'Passenger notified that you are still coming',
        body: 'Please head to the pickup point.',
        submitting: false,
        answered: true,
        decisionOpen: false,
        clearRespondBy: true,
        actions: const [
          CoordinationAction.callOtherParty,
          CoordinationAction.openNavigation,
          CoordinationAction.requestCancel,
        ],
      ),
    );
    _analytics.logCoordination('still_coming_confirmed',
        rideId: rideId,
        eventId: current.eventId,
        stage: current.stage.wire,
        extra: {'minutes': (data['minutes'] as num?)?.toInt()});
  }

  void _onActivitySeen(Map<String, dynamic> data) {
    if (data['rideId']?.toString() != _activeRideId) return;
    if (data['by']?.toString() != 'passenger') return;
    final text = switch (data['type']?.toString()) {
      'passenger_called_driver' => 'The passenger is trying to call you.',
      'passenger_keep_waiting' => 'The passenger is on their way out to you.',
      'chat_message' => 'The passenger sent you a message.',
      _ => null,
    };
    if (text == null) return;
    state = state.copyWith(errorMessage: text);
    _scheduleErrorClear(seconds: 6);
  }

  /// Our own cancellation request was accepted for delivery. The ride stays
  /// active — a request is not a cancellation.
  void _onCancelRequestAck(Map<String, dynamic> data) {
    final rideId = data['rideId']?.toString();
    if (rideId == null || rideId != _activeRideId) return;

    if (data['accepted'] != true) {
      state = state.copyWith(
        coordination: state.coordination?.copyWith(submitting: false),
        errorMessage: data['reason']?.toString() == 'request_already_pending'
            ? 'There is already a cancellation request on this ride.'
            : 'We could not send that just now. Please try again.',
      );
      _scheduleErrorClear(seconds: 6);
      return;
    }

    final deadline = DateTime.tryParse(data['respondByAt']?.toString() ?? '');
    state = state.copyWith(
      coordination: RideCoordination(
        rideId: rideId,
        stage: CoordinationStage.cancellationRequested,
        title: 'Waiting for a response to your cancellation',
        body: 'We have asked the passenger. The ride stays active until they answer.',
        eventId: data['eventId']?.toString() ?? '$rideId:cancel_request_pending',
        respondByAt: deadline?.toUtc(),
        cancellationRequestedBy: 'driver',
        cancellationRequestState: 'pending',
        requestedByMe: true,
        rideStatus: state.coordination?.rideStatus ?? 'accepted',
        actions: const [CoordinationAction.callOtherParty],
      ),
    );
    _analytics.logCoordination('cancellation_requested',
        rideId: rideId,
        eventId: data['eventId']?.toString(),
        stage: CoordinationStage.cancellationRequested.wire);
  }

  /// The server's verdict on a response we sent. Authoritative: a refusal here
  /// means the answer did not land, whatever the UI was showing.
  void _onCoordinationAck(Map<String, dynamic> data) {
    final rideId = data['rideId']?.toString();
    if (rideId == null || rideId != _activeRideId) return;
    final current = state.coordination;
    if (current == null) return;

    final accepted = data['accepted'] as bool? ?? (data['applied'] as bool? ?? false);
    if (accepted) {
      state = state.copyWith(
        coordination: current.copyWith(
          submitting: false,
          answered: true,
          decisionOpen: false,
        ),
      );
      _analytics.logCoordination('prompt_acknowledged',
          rideId: rideId,
          eventId: current.eventId,
          stage: current.stage.wire,
          extra: {'choice': data['choice']?.toString() ?? data['decision']?.toString()});
      return;
    }

    final reason = data['reason']?.toString();
    final message = switch (reason) {
      'already_decided' => 'The passenger already answered this one.',
      'extension_limit_reached' => data['message']?.toString() ??
          'You have already confirmed once on this ride. Please arrive, or cancel.',
      _ => 'We could not record that. Please try again.',
    };
    state = state.copyWith(
      coordination: current.copyWith(submitting: false),
      errorMessage: message,
    );
    _scheduleErrorClear(seconds: 8);
    _analytics.logCoordination('response_rejected',
        rideId: rideId,
        eventId: current.eventId,
        stage: current.stage.wire,
        extra: {'reason': reason});
    refreshCoordination();
  }

  /// Act on the driver's choice. Everything that changes the ride goes to the
  /// server and waits for its answer; nothing is applied on the optimistic
  /// assumption that it worked.
  void respondToCoordination(CoordinationAction action) {
    final current = state.coordination;
    final rideId = _activeRideId;
    if (current == null || rideId == null) return;
    if (current.submitting) return;

    switch (action) {
      case CoordinationAction.stillComing:
      case CoordinationAction.continueRide:
        _confirmStillComing(current, rideId, action);
        return;

      case CoordinationAction.keepWaiting:
        // Arrived, waiting for the passenger. Answering the prompt with "wait" is
        // what buys the bounded extension.
        state = state.copyWith(coordination: current.copyWith(submitting: true));
        _socketService?.emit('ride:stale_decision', {
          'rideId': rideId,
          'userId': _userId,
          'role': 'driver',
          'choice': 'wait',
        });
        _analytics.logCoordination('keep_waiting',
            rideId: rideId, eventId: current.eventId, stage: current.stage.wire);
        return;

      case CoordinationAction.acceptCancellation:
        state = state.copyWith(coordination: current.copyWith(submitting: true));
        _socketService?.emit('ride:cancel_response', {
          'rideId': rideId,
          'userId': _userId,
          'role': 'driver',
          'decision': 'accept',
        });
        _analytics.logCoordination('cancellation_accepted',
            rideId: rideId, eventId: current.eventId, stage: current.stage.wire);
        return;

      case CoordinationAction.requestCancel:
      case CoordinationAction.findAnotherDriver:
        state = state.copyWith(coordination: current.copyWith(submitting: true));
        // A request, not a cancellation. The passenger still gets to answer.
        _socketService?.emit('ride:cancel_request', {
          'rideId': rideId,
          'userId': _userId,
          'role': 'driver',
        });
        return;

      case CoordinationAction.callOtherParty:
        // The dial is the UI's job; reporting it here is what makes it count as
        // evidence the ride is alive. The server cannot see a phone call.
        _socketService?.emit('ride:activity', {
          'rideId': rideId,
          'userId': _userId,
          'role': 'driver',
          'type': 'driver_called_passenger',
        });
        _analytics.logCoordination('call_used',
            rideId: rideId, eventId: current.eventId, stage: current.stage.wire);
        return;

      case CoordinationAction.shareLocation:
        _socketService?.emit('ride:activity', {
          'rideId': rideId,
          'userId': _userId,
          'role': 'driver',
          'type': 'driver_shared_location',
        });
        _analytics.logCoordination('location_shared',
            rideId: rideId, eventId: current.eventId, stage: current.stage.wire);
        return;

      case CoordinationAction.onMyWay:
        _confirmStillComing(current, rideId, action);
        return;

      case CoordinationAction.messageOtherParty:
        _analytics.logCoordination('message_used',
            rideId: rideId, eventId: current.eventId, stage: current.stage.wire);
        return;

      case CoordinationAction.contactSupport:
        _analytics.logCoordination('support_opened',
            rideId: rideId, eventId: current.eventId, stage: current.stage.wire);
        return;

      case CoordinationAction.openNavigation:
        _analytics.logCoordination('navigation_opened',
            rideId: rideId, eventId: current.eventId, stage: current.stage.wire);
        return;
    }
  }

  /// "I'm still coming."
  ///
  /// Deliberately does NOT mark the driver arrived — confirming you are on your
  /// way is not the same as being there, and conflating them would let a driver
  /// skip the geofence that protects the pickup.
  void _confirmStillComing(
    RideCoordination current,
    String rideId,
    CoordinationAction action,
  ) {
    state = state.copyWith(coordination: current.copyWith(submitting: true));

    if (current.stage == CoordinationStage.cancellationRequested &&
        !current.requestedByMe) {
      // Declining the passenger's cancellation request is its own event, and it
      // doubles as "still coming".
      _socketService?.emit('ride:cancel_response', {
        'rideId': rideId,
        'userId': _userId,
        'role': 'driver',
        'decision': 'continue',
      });
      _analytics.logCoordination('cancellation_declined',
          rideId: rideId, eventId: current.eventId, stage: current.stage.wire);
      return;
    }

    if (current.decisionOpen) {
      // There is an open prompt: answering it is what the server is waiting for.
      _socketService?.emit('ride:stale_decision', {
        'rideId': rideId,
        'userId': _userId,
        'role': 'driver',
        'choice': 'wait',
      });
    } else {
      // A soft reminder with no open prompt. `ride:still_coming` is the driver-only
      // path for exactly this, and it acks with ride:extension_granted.
      _socketService?.emit('ride:still_coming', {
        'rideId': rideId,
        'driverId': _userId,
      });
    }
    _analytics.logCoordination('still_coming_selected',
        rideId: rideId, eventId: current.eventId, stage: current.stage.wire);
  }

  /// Re-read the authoritative coordination state. Called on launch, on reconnect
  /// and after a rejected response — this is what makes a prompt survive a process
  /// restart, and what stops an answered prompt from coming back.
  Future<void> refreshCoordination() async {
    final rideId = _activeRideId;
    if (rideId == null) return;
    try {
      final response = await _apiClient.dio.get('/rides/$rideId/coordination');
      if (!mounted || _activeRideId != rideId) return;

      final data = response.data;
      final block = data is Map ? data['coordination'] : null;
      if (block is! Map) {
        if (state.coordination != null) {
          state = state.copyWith(clearCoordination: true);
        }
        return;
      }
      final parsed = RideCoordination.fromWire(
        block.map((k, v) => MapEntry(k.toString(), v)),
        role: 'driver',
      );
      if (parsed == null) {
        state = state.copyWith(clearCoordination: true);
        return;
      }
      _rememberCoordinationEvent(parsed.eventId);
      state = state.copyWith(
        coordination: parsed.copyWith(
          answered: !parsed.decisionOpen && parsed.decidedByMe,
        ),
      );
    } catch (e) {
      print('[DRIVER] Coordination refresh failed: $e');
    }
  }

  /// A ride ended. The server classifies how; the app only renders it.
  void _handleRideCancelled(Map<String, dynamic> data) {
    final closure = RideClosure.fromWire(data['outcome']?.toString());
    _analytics.logCoordination('ride_closed',
        rideId: data['rideId']?.toString(),
        eventId: data['eventId']?.toString(),
        stage: 'closed',
        extra: {'outcome': closure.name, 'reasonCode': data['reason']?.toString()});

    _resetToAvailable();

    // An offer merely withdrawn during dispatch needs no explanation — the driver
    // never had this ride.
    if (closure == RideClosure.offerWithdrawn) return;

    if (!mounted) return;
    state = state.copyWith(
      closure: closure,
      closureTitle: data['title']?.toString() ?? 'Ride closed',
      closureBody: data['body']?.toString() ?? _defaultClosureBody(closure),
    );
  }

  static String _defaultClosureBody(RideClosure closure) => switch (closure) {
        RideClosure.closedNoResponse =>
          'This ride was closed after neither party responded.',
        RideClosure.cancelledRequestUnanswered =>
          'The cancellation request went unanswered, so the ride was closed. '
              'You can accept new rides now.',
        RideClosure.cancelledByPassenger =>
          'The passenger cancelled this ride. You can accept new rides now.',
        RideClosure.resolvedBySupport =>
          'Our team closed this ride. Please contact support if you need anything else.',
        _ => 'This ride has been cancelled. You can accept new rides now.',
      };

  /// Dismiss the closing card and get back on the road.
  void dismissClosure() {
    if (state.closure == null) return;
    state = state.copyWith(clearClosure: true);
  }

  // --- Trip Lifecycle ---

  void markArrived() {
    if (_socketService == null || state.activeRequest == null) return;

    _socketService!.emit('ride:arrived', {
      'rideId': state.activeRequest!.id,
      'driverId': _userId,
    });

    // ARRIVAL SETTLES THE QUESTION. Any "are you still coming?" card goes now —
    // the driver being here is the answer, and leaving the prompt up next to
    // "you have arrived" would be nonsense. A separate waiting-for-passenger
    // conversation may start later; the server drives that, not this.
    state = state.copyWith(
      tripStep: TripStep.arrived,
      waitTimeSeconds: 0,
      clearPickupRoute: true,
      clearRouteEta: true,
      clearCoordination: true,
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
    // The trip is under way. An in-progress ride is only ever flagged for a
    // human, never cancelled on a timer, so no coordination UI may appear.
    state = state.copyWith(tripStep: TripStep.started, clearCoordination: true);
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
      awaitingEarlyEndConfirmation: false,
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

  /// Re-read the server and heal whatever drifted.
  ///
  /// Delegates to [recoverActiveRide] rather than carrying a second copy of the
  /// parsing and mapping. It previously had its own — and when the ride was not
  /// in memory it called `_initDriver()`, re-running the whole profile fetch to
  /// get at the recovery buried inside it.
  Future<void> syncStatus({
    DriverRecoverySource source = DriverRecoverySource.socketReconnect,
  }) async {
    if (state.tripStep == TripStep.completed) return; // receipt showing
    await recoverActiveRide(source);
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
    WidgetsBinding.instance.removeObserver(this);
    // Stop the foreground service so a disposed controller (e.g. on logout /
    // auth change) can't keep the heartbeat isolate posting with a stale token.
    // If the driver is still online, the fresh controller's auto-resume restarts it.
    _stopLocationForegroundService();
    ReliabilityLog.log(RelEvent.logoutCleanup, {});
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

/// Whether this handset can actually be reached with work.
///
/// Kept beside the driver controller because going online is what triggers
/// the check, and because the service caches the server's verdict between
/// checks so a recheck does not always need a round trip.
final driverReadinessProvider = Provider<DriverReadinessService>((ref) {
  return DriverReadinessService(ref.watch(apiClientProvider).dio);
});

final driverControllerProvider = StateNotifierProvider<DriverController, DriverState>((ref) {
  final apiClient = ref.watch(apiClientProvider);
  final authState = ref.watch(authControllerProvider);
  
  final socketService = ref.read(socketServiceProvider);
  final notificationService = ref.read(notificationServiceProvider('driver'));
  final soundService = ref.read(soundServiceProvider);
  final secureStorage = ref.read(secureStorageServiceProvider);

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
      return DriverController(null, apiClient, notificationService, soundService, 'session_invalid', secureStorage, authState.token);
    }
  }

  final controller = DriverController(socketService, apiClient, notificationService, soundService, userId, secureStorage, authState.token);

  controller.setWalletRefreshCallback(
    () => ref.read(driverFinanceControllerProvider.notifier).refresh(),
  );

  // Listen for socket updates without re-creating the controller
  ref.listen(socketServiceProvider, (previous, next) {
    controller.updateSocketService(next);
  });

  return controller;
});
