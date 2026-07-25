import 'dart:async';
import 'dart:math' as math;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import '../domain/booking_notice.dart';
import '../domain/booking_state.dart';
import '../domain/nearby_keke.dart';
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
import '../../../core/services/analytics_service.dart';

/// How long the passenger app waits for ANY server verdict on a search before
/// giving up on its own. Must exceed the server's total search lifetime across
/// all dispatch rounds; see the note in [BookingController._startWatchdog].
const Duration _searchWatchdogTimeout = Duration(seconds: 150);

class BookingController extends StateNotifier<BookingState> {
  final MapRepository _mapRepo;
  SocketService? _socketService;
  final ApiClient? _apiClient;
  final AnalyticsService _analytics;
  final String passengerId;
  final String firstName;
  final String lastName;

  Timer? _debounceTimer;
  Timer? _watchdogTimer;
  Timer? _searchTimeoutTimer;
  Timer? _nearbyPollingTimer;
  Timer? _errorClearTimer;
  Timer? _noticeClearTimer;
  Timer? _searchingKekeTimer;
  StreamSubscription? _socketSubscription;
  StreamSubscription? _notificationSubscription;
  final NotificationService _notificationService;
  final SoundService _soundService;
  void Function()? _onWalletRefreshNeeded;

  void setWalletRefreshCallback(void Function() cb) => _onWalletRefreshNeeded = cb;

  BookingController(this._mapRepo, SocketService? initialSocket, this._apiClient, this._notificationService, this._soundService, this._analytics, this.passengerId, this.firstName, this.lastName) : super(const BookingState()) {
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
        case 'ride:dispatch_round':
          // The server started another automatic dispatch round on the SAME ride.
          // Nothing is re-sent from here — this only advances the copy the
          // passenger is reading, and re-arms the watchdog for the new round.
          final round = (data['dispatchRound'] as num?)?.toInt();
          if (round == null || round <= state.searchRound) break;
          print('[PASSENGER_SYNC] Dispatch round $round started for ${state.rideId}');
          state = state.copyWith(
            step: BookingStep.searching,
            searchRound: round,
            clearErrorMessage: true,
            clearNotice: true,
          );
          _analytics.log('passenger_dispatch_round', {
            'rideId': state.rideId,
            'dispatchRound': round,
            'totalRounds': (data['totalRounds'] as num?)?.toInt(),
            'offersSentCount': (data['offersSentCount'] as num?)?.toInt(),
            'explicitRejectCount': (data['explicitRejectCount'] as num?)?.toInt(),
          });
          _startWatchdog();
          // Round two searches a wider area: refresh markers now rather than
          // waiting out the interval, so the map matches the new search area.
          // Existing markers are kept until the response lands, so drivers who
          // are still eligible do not blink out and back in.
          _fetchSearchingKekes();
          break;
        case 'socket:reconnected':
          print('[PASSENGER_SYNC] Socket reconnected. Triggering redundant healing...');
          syncStatus();
          // Markers may have aged out while offline — rebuild from live truth.
          if (state.step == BookingStep.searching) _fetchSearchingKekes();
          break;
        case 'ride:assigned':
          _searchTimeoutTimer?.cancel();
          // A driver is ours: every unrelated nearby marker goes at once, and the
          // existing assigned-driver tracking flow takes over the map.
          _stopSearchingKekeFeed(clearMarkers: false);
          state = state.copyWith(
            step: BookingStep.confirmed,
            assignedDriver: data['driverDetails'],
            pickupCode: data['pickupCode']?.toString(),
            clearErrorMessage: true,
            clearNotice: true,
            clearNearbyKekes: true,
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
        case 'ride:early_end_request':
          print('[PASSENGER] Driver requested early drop-off confirmation.');
          state = state.copyWith(earlyEndRequested: true);
          _soundService.playAlert();
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
          _reportOutcome(RideOutcome.passengerCancelled,
              dispatchResult: 'passenger_cancelled');
          _resetBookingState(
              notice: BookingNotice.of(RideOutcome.passengerCancelled));
          _scheduleNoticeClear(seconds: 8);
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
          // Newer servers say WHY (no eligible driver vs. nobody accepted vs.
          // expired). Older ones send only a message — those get the
          // conservative "nobody accepted" reading, which is the common case.
          final failOutcome =
              RideOutcomeWire.fromCode(data['code']?.toString()) ??
                  RideOutcome.noDriverAccepted;
          _endSearchWith(
            failOutcome,
            dispatchResult: data['dispatchResult']?.toString() ?? 'unspecified',
            dispatchEvidence: _dispatchEvidenceOf(data),
          );
          break;
        case 'ride:error':
          _handleServerError(
            code: data['code']?.toString(),
            message: data['message']?.toString(),
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

  void _resetBookingState({BookingNotice? notice}) {
    // Cancellation / completion: the searching marker feed stops here too.
    // Rebuilding BookingState below drops nearbyKekes back to empty.
    _stopSearchingKekeFeed(clearMarkers: false);
    // Construct cleanly so all receipt/ride fields truly reset to null defaults.
    state = BookingState(
      step: BookingStep.selectingDestination,
      mapCenter: state.mapCenter,
      pickupLocation: state.pickupLocation,
      pickupAddress: 'Locating...',
      paymentMethod: state.paymentMethod,
      notice: notice,
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
    // The provider can be disposed while location or recovery is still in
    // flight (fast app exit, auth change). Writing state afterwards throws.
    if (!mounted) return;
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
        if (!mounted) return;
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
          // A recovered still-searching ride gets its marker feed back too
          // (cold start from a notification, or app relaunch mid-search).
          if (restoredStep == BookingStep.searching) {
            _startWatchdog();
            _startSearchingKekeFeed();
          }
          return; // Skip default search if recovered
        }
      } catch (e) {
        print('Active ride recovery failed: $e');
        if (!mounted) return;
        state = state.copyWith(
          notice: BookingNotice.of(RideOutcome.serverFailed,
              dispatchResult: 'active_ride_recovery_failed'),
        );
      }
    }

    if (!mounted) return;
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
    // Reached from the fare screen via "Change pickup point" — the destination
    // is still set, so go straight back to the (re-priced) estimate instead of
    // dumping the passenger on the home panel.
    if (state.destinationLocation != null) {
      state = state.copyWith(step: BookingStep.previewEstimate);
      _calculateFare();
      return;
    }
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
    state = state.copyWith(
      step: state.destinationLocation != null
          ? BookingStep.previewEstimate
          : BookingStep.selectingDestination,
    );
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
    state = state.copyWith(
        clearErrorMessage: true, clearNotice: true, estimatedFareAmount: null);

    try {
      final estimate = await _mapRepo.calculateRouteAndFare(state.pickupLocation!, state.destinationLocation!);
      state = state.copyWith(
        estimatedDistance: estimate['distance'] as String,
        estimatedTime: estimate['time'] as String,
        estimatedFareAmount: estimate['fare'] as int,
        activeRoutePolyline: List<LatLng>.from(estimate['polyline']),
      );
    } catch (e) {
      // Couldn't route between these two points — an unusable pickup/destination
      // pair, which is a real failure and keeps the red treatment.
      state = state.copyWith(
        notice: BookingNotice.of(RideOutcome.invalidRoute,
            dispatchResult: 'route_calculation_failed'),
      );
    }
  }

  /// First attempt for this pickup/destination pair.
  void requestRide() => _dispatchRequest(isRetry: false);

  /// "Search Again" from the no-driver notice. Same request, second round —
  /// the searching screen switches to its "Still searching nearby…" copy.
  /// Purely passenger-driven; no automatic redispatch happens here.
  void searchAgain() => _dispatchRequest(isRetry: true);

  /// "Change pickup point" from the notice — hands the passenger the existing
  /// map-based pickup picker instead of silently retrying the same spot.
  void changePickupPoint() {
    clearNotice();
    enterPickupMapSelection();
  }

  void _dispatchRequest({required bool isRetry}) {
    if (_socketService == null) {
      _showRequestBlocked(RideOutcome.serverFailed);
      return;
    }
    if (state.pickupLocation == null || state.destinationLocation == null) {
      _showRequestBlocked(RideOutcome.invalidRoute);
      return;
    }
    if (!_socketService!.isConnected) {
      _showRequestBlocked(RideOutcome.networkFailed);
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
    
    final attempts = state.searchAttempts + 1;
    state = state.copyWith(
      step: BookingStep.searching,
      rideId: rideId,
      searchAttempts: attempts,
      searchRound: isRetry ? 2 : 1,
      clearErrorMessage: true,
      clearNotice: true,
    );
    _analytics.logSearchStarted(
      rideId: rideId,
      searchAttempts: attempts,
      searchRound: state.searchRound,
    );
    _startWatchdog();
    _startSearchingKekeFeed();
  }

  /// The request never left the device (no socket, no data, bad coordinates).
  /// Stays on the fare screen and shows an error-toned notice — these are real
  /// failures, not availability outcomes.
  void _showRequestBlocked(RideOutcome outcome) {
    _reportOutcome(outcome, dispatchResult: 'not_dispatched');
    _noticeClearTimer?.cancel();
    state = state.copyWith(
      notice: BookingNotice.of(outcome, dispatchResult: 'not_dispatched'),
    );
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

  /// Controlled refresh cadence for nearby-Keke markers while a ride is
  /// searching. Deliberately NOT per-heartbeat: before a driver has accepted,
  /// the passenger gets a periodic approximate picture of supply, never
  /// second-by-second tracking of anyone.
  static const Duration searchingKekeRefresh = Duration(seconds: 8);

  /// Pre-request browse cadence (unchanged).
  static const Duration _browseNearbyRefresh = Duration(seconds: 10);

  static const _browseSteps = {
    BookingStep.selectingPickup,
    BookingStep.selectingDestination,
    BookingStep.previewEstimate,
    BookingStep.idle,
  };

  void _startNearbyPolling() {
    _nearbyPollingTimer?.cancel();

    // Fetch immediately on start
    _fetchNearbyDrivers();

    _nearbyPollingTimer = Timer.periodic(_browseNearbyRefresh, (_) {
      if (_browseSteps.contains(state.step)) {
        _fetchNearbyDrivers();
      }
    });
  }

  // ── Nearby-Keke markers during searching ────────────────────────────────

  /// Begin the searching-state marker feed. Read-only: it asks the server which
  /// Kekes are genuinely dispatch-eligible for THIS ride and draws nothing else.
  void _startSearchingKekeFeed() {
    _searchingKekeTimer?.cancel();
    _fetchSearchingKekes();
    _searchingKekeTimer = Timer.periodic(searchingKekeRefresh, (_) {
      if (state.step != BookingStep.searching) {
        _stopSearchingKekeFeed();
        return;
      }
      _fetchSearchingKekes();
    });
  }

  /// Stop the feed and clear the markers. Called on acceptance, cancellation,
  /// failure and disposal — a marker must never outlive the search it described.
  void _stopSearchingKekeFeed({bool clearMarkers = true}) {
    _searchingKekeTimer?.cancel();
    _searchingKekeTimer = null;
    if (clearMarkers && mounted && !state.nearbyKekes.isEmpty) {
      state = state.copyWith(clearNearbyKekes: true);
    }
  }

  Future<void> _fetchSearchingKekes() async {
    final rideId = state.rideId;
    if (_apiClient == null || rideId == null) return;
    if (state.step != BookingStep.searching) return;

    try {
      final response = await _apiClient!.dio.get('/rides/$rideId/nearby-kekes');
      if (!mounted || state.step != BookingStep.searching) return;
      // A response for a previous ride must never repopulate this one's map.
      if (state.rideId != rideId) return;

      final data = response.data;
      if (data is! Map) return;
      final feed = NearbyKekeFeed.fromJson(
        Map<String, dynamic>.from(data),
        now: DateTime.now(),
      );
      state = state.copyWith(nearbyKekes: feed);
    } catch (e) {
      // Offline or the ride is no longer searching. Do NOT keep drawing supply
      // we can't confirm: age the existing markers out by their expiry instead.
      print('[NEARBY_KEKE] refresh failed: $e');
      if (!mounted) return;
      final pruned = state.nearbyKekes.prunedAt(DateTime.now());
      if (pruned != state.nearbyKekes) {
        state = state.copyWith(nearbyKekes: pruned);
      }
    }
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
    // Client-side backstop only. The server owns the real search budget
    // (DISPATCH_MAX_SEARCH_LIFETIME_MS, 110s across both dispatch rounds) and
    // reports the true outcome via ride:failed. This timer must therefore sit
    // comfortably BEYOND that, or it would cut a legitimate round two short and
    // report an expiry the server never decided. It re-arms on every round
    // transition, so it only fires if the server goes silent entirely.
    _searchTimeoutTimer = Timer(_searchWatchdogTimeout, () {
      if (mounted && state.step == BookingStep.searching) {
        print('[WATCHDOG] Search timed out — rolling back to estimate.');
        _stopWatchdog();
        // The server never told us how dispatch ended (it usually beats us to
        // it with ride:failed) — this is specifically an expiry, not a
        // statement about driver availability.
        _endSearchWith(RideOutcome.requestExpired,
            dispatchResult: 'client_watchdog_timeout');
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
      // Prompt the passenger to rate this driver (only if we still know the
      // driver — held-for-review or driverless rides can't be rated).
      pendingReviewRideId: state.receiptDriver != null || state.assignedDriver != null ? state.rideId : null,
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

  /// Dismisses the current outcome notice (passenger acted on it, or it aged out).
  void clearNotice() {
    _noticeClearTimer?.cancel();
    if (mounted) state = state.copyWith(clearNotice: true);
  }

  void _scheduleNoticeClear({int seconds = 8}) {
    _noticeClearTimer?.cancel();
    _noticeClearTimer = Timer(Duration(seconds: seconds), () {
      if (mounted) state = state.copyWith(clearNotice: true);
    });
  }

  // ── Ride outcome plumbing ──────────────────────────────────────────────
  //
  // Every way a request can end without a driver funnels through here, so the
  // passenger-facing copy, the visual tone and the analytics event all come
  // from one place and can never drift apart.

  /// Pulls the server's structured dispatch counts out of a ride:failed payload.
  /// All fields are optional — an older server sends none of them.
  Map<String, Object?> _dispatchEvidenceOf(Map<String, dynamic> data) {
    const keys = [
      'dispatchRound',
      'roundsRun',
      'eligibleDriverCount',
      'reservedDriverCount',
      'offersSentCount',
      'explicitRejectCount',
      'expiredOfferCount',
      'deliveryFailureCount',
      'acknowledgedCount',
    ];
    final out = <String, Object?>{};
    for (final key in keys) {
      final value = (data[key] as num?)?.toInt();
      if (value != null) out[key] = value;
    }
    return out;
  }

  void _reportOutcome(
    RideOutcome outcome, {
    String? dispatchResult,
    Map<String, Object?> dispatchEvidence = const {},
  }) {
    _analytics.logRideOutcome(
      rideId: state.rideId,
      outcome: outcome,
      dispatchResult: dispatchResult,
      searchAttempts: state.searchAttempts,
      searchRound: state.searchRound,
      dispatchEvidence: dispatchEvidence,
    );
  }

  /// Terminal end of a search: log it, drop back to the fare screen and show
  /// the matching notice. Does NOT re-dispatch — retry is the passenger's call.
  void _endSearchWith(
    RideOutcome outcome, {
    String? dispatchResult,
    Map<String, Object?> dispatchEvidence = const {},
  }) {
    _reportOutcome(outcome,
        dispatchResult: dispatchResult, dispatchEvidence: dispatchEvidence);
    _noticeClearTimer?.cancel();
    // The search is over — stop the marker feed and drop its markers, so the
    // map never shows supply for a ride that is no longer being dispatched.
    _stopSearchingKekeFeed(clearMarkers: false);
    state = state.copyWith(
      step: BookingStep.previewEstimate,
      clearRideId: true,
      clearErrorMessage: true,
      clearNearbyKekes: true,
      notice: BookingNotice.of(outcome, dispatchResult: dispatchResult),
    );
  }

  /// A `ride:error` from the server. While searching this is terminal (the
  /// request never got off the ground — e.g. the passenger already has a live
  /// ride, which previously left the search spinning until the 90s watchdog).
  /// Outside a search it's a transient notice that must not disturb the step.
  void _handleServerError({String? code, String? message}) {
    final outcome =
        RideOutcomeWire.fromCode(code) ?? RideOutcome.serverFailed;
    print('[PASSENGER] Server error: code=$code message=$message '
        '→ ${outcome.code}');

    if (state.step == BookingStep.searching) {
      _searchTimeoutTimer?.cancel();
      _stopWatchdog();
      _endSearchWith(outcome, dispatchResult: 'server_rejected');
      return;
    }
    _reportOutcome(outcome, dispatchResult: 'server_rejected');
    state = state.copyWith(
        notice: BookingNotice.of(outcome, dispatchResult: 'server_rejected'));
    _scheduleNoticeClear();
  }

  Future<void> triggerSos(String reason) async {
    if (_socketService == null || state.rideId == null) return;
    final loc = await _mapRepo.getCurrentLocation();
    _socketService!.emit('ride:sos', {
      'rideId': state.rideId,
      'initiatorId': passengerId,
      'initiatorRole': 'passenger',
      'reason': reason,
      'lat': loc?.latitude ?? state.pickupLocation?.latitude ?? 0.0,
      'lng': loc?.longitude ?? state.pickupLocation?.longitude ?? 0.0,
    });
  }

  /// Passenger taps "End Trip Here" — end the trip at their current location.
  /// The server settles the full quoted fare; consent overrides only the
  /// destination-proximity check (movement/duration still enforced).
  Future<void> endTripHere() async {
    if (_socketService == null || state.rideId == null) return;
    final loc = await _mapRepo.getCurrentLocation();
    _socketService!.emit('ride:end_early', {
      'rideId': state.rideId,
      'passengerId': passengerId,
      'lat': loc?.latitude,
      'lng': loc?.longitude,
    });
  }

  /// Passenger confirms the driver's "dropped off here" request.
  Future<void> confirmEarlyEnd() async {
    state = state.copyWith(earlyEndRequested: false);
    await endTripHere();
  }

  /// Passenger disputes the driver's early-end request → ride is held for review.
  void rejectEarlyEnd() {
    state = state.copyWith(earlyEndRequested: false);
    if (_socketService == null || state.rideId == null) return;
    _socketService!.emit('ride:reject_early_end', {
      'rideId': state.rideId,
      'passengerId': passengerId,
    });
  }

  /// Passenger submits a star rating (+ optional tags/comment) for the driver
  /// of the just-completed ride. Returns true on success. Clears the pending
  /// review either way on success so the receipt stops prompting.
  Future<bool> submitReview({required int stars, List<String> tags = const [], String? comment}) async {
    final rideId = state.pendingReviewRideId;
    if (_apiClient == null || rideId == null) return false;
    try {
      await _apiClient!.dio.post('/rides/$rideId/review', data: {
        'stars': stars,
        'tags': tags,
        if (comment != null && comment.trim().isNotEmpty) 'comment': comment.trim(),
      });
      state = state.copyWith(clearPendingReview: true);
      return true;
    } catch (e) {
      print('[REVIEW] submit failed: $e');
      return false;
    }
  }

  /// Passenger dismisses the rating prompt without rating.
  void skipReview() {
    if (state.pendingReviewRideId == null) return;
    state = state.copyWith(clearPendingReview: true);
  }

  void cancelBooking() {
    // Trip already in progress — cancellation not allowed
    if (state.step == BookingStep.started) return;
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
    _noticeClearTimer?.cancel();
    _searchingKekeTimer?.cancel();
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
  final analytics = ref.read(analyticsServiceProvider);

  final controller = BookingController(mapRepo, socketService, apiClient, notificationService, soundService, analytics, passId, fname, lname);

  controller.setWalletRefreshCallback(
    () => ref.read(walletControllerProvider.notifier).refresh(),
  );

  // Listen for socket updates without re-creating the controller
  ref.listen(socketServiceProvider, (previous, next) {
    controller.updateSocketService(next);
  });

  return controller;
});
