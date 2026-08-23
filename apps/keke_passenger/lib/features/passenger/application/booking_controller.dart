import 'dart:async';
import 'dart:math' as math;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import '../domain/booking_notice.dart';
import '../domain/booking_state.dart';
import '../domain/resolved_place.dart';
import '../domain/live_trip_diagnostics.dart';
import '../../../core/diagnostics/boot_trace.dart';
import 'active_ride_recovery.dart';
import '../../../core/services/ride_status_notification.dart';
import '../domain/nearby_keke.dart';
import '../domain/ride_coordination.dart';
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

  /// Raw route estimates from the last fare calculation, reported with the ride
  /// request purely for admin/support visibility (never for pricing).
  int? _estimatedDistanceMeters;
  int? _estimatedDurationSeconds;
  StreamSubscription? _socketSubscription;
  StreamSubscription? _notificationSubscription;
  final NotificationService _notificationService;
  final SoundService _soundService;
  void Function()? _onWalletRefreshNeeded;

  void setWalletRefreshCallback(void Function() cb) => _onWalletRefreshNeeded = cb;

  BookingController(this._mapRepo, SocketService? initialSocket, this._apiClient, this._notificationService, this._soundService, this._analytics, this.passengerId, this.firstName, this.lastName) : super(const BookingState()) {
    _socketService = initialSocket;
    if (_socketService != null) _listenToSocket();
    _listenToNotifications();
    _startNearbyPolling();

    /*
     * Recovery first, map second.
     *
     * The old order awaited the device location, painted the booking screen,
     * and only then asked whether the passenger was already on a ride — so a
     * passenger with a driver en route saw "Where to?" every single cold start,
     * and kept seeing it if the recovery call happened to fail.
     */
    _bootstrap();

    /*
     * Keep the status-bar entry in step with the ride, from one place.
     *
     * A listener rather than calls scattered through the twenty-odd sites that
     * change the ride: recovery, every socket event, cancellation, completion
     * and terminal cleanup all write `state`, and any of them could have been
     * forgotten. show() is idempotent on unchanged copy, so the frequent writes
     * (driver location, ETA) cost a string comparison.
     */
    addListener((_) {
      _syncRideNotification();
      // The live-trip monitor's lifetime follows the ride, not any one event.
      if (_isTrackingRide) {
        _startLiveTripMonitor();
      } else {
        _stopLiveTripMonitor();
      }
    }, fireImmediately: false);
  }

  /// Cold start: settle the ride question before anything else is drawn.
  ///
  /// Laying out the booking flow is the `none` branch's job inside
  /// [recoverActiveRide] — doing it here on `!found` would also do it when the
  /// check FAILED, which is how a passenger with no network would still end up
  /// staring at "Where to?" while their driver approached.
  Future<void> _bootstrap() => recoverActiveRide(RecoverySource.coldStart);

  void _listenToNotifications() {
    _notificationSubscription = _notificationService.intentStream.listen((data) {
      print('[PASSENGER_SYNC] Notification intent received: $data. Verifying with server...');
      /*
       * The payload is a hint, never the state. A push saying "driver arrived"
       * may be minutes old by the time it is tapped, and the ride may since have
       * started or been cancelled. Always re-read the server.
       */
      syncStatus(source: RecoverySource.notificationTap);

      // A coordination push and the socket event that accompanies it describe the
      // SAME question. The server sends a matching `eventId` on both, so marking
      // it seen here means whichever arrives second does not raise a second
      // prompt — the passenger is asked once.
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
        final fresh = _rememberCoordinationEvent(eventId);
        if (fresh) {
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
        case 'ride:offer_sent':
          /*
           * A driver has actually been offered this ride and is deciding.
           *
           * Only the copy changes — no timer, no watchdog, no lifecycle move.
           * The passenger is still waiting and can still cancel, and the
           * driver may yet decline, in which case the next dispatch round
           * puts us back to `searching` through the handler below.
           */
          if (state.step == BookingStep.searching) {
            state = state.copyWith(step: BookingStep.offerSent);
          }
          break;

        case 'ride:dispatch_round':
          // The server started another automatic dispatch round on the SAME ride.
          // Nothing is re-sent from here — this only advances the copy the
          // passenger is reading, and re-arms the watchdog for the new round.
          final round = (data['dispatchRound'] as num?)?.toInt();
          if (round == null || round <= state.searchRound) break;
          // A fresh round means the previous offer was not taken. Stop saying
          // "driver found" — it is no longer true.
          if (state.step == BookingStep.offerSent) {
            state = state.copyWith(step: BookingStep.searching);
          }
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
          print('[PASSENGER_SYNC] Socket reconnected. Re-reading server truth...');
          syncStatus(source: RecoverySource.socketReconnect);
          // Whatever prompt we were showing may have been answered, expired or
          // superseded while we were offline. The server is the only authority on
          // that, so throw ours away and re-read.
          refreshCoordination();
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
            clearCoordination: true,
            clearClosure: true,
          );
          _stopWatchdog();
          _soundService.playAlert();
          break;
        case 'ride:status_update':
           print('[PASSENGER_SYNC] Status update: ${data['status']}');
           if (data['status'] == 'arrived') {
             // ARRIVAL SETTLES THE QUESTION. Whatever we were asking about the
             // driver being late is answered by them being here, so the card goes
             // rather than lingering next to "your driver has arrived".
             state = state.copyWith(
               step: BookingStep.arrived,
               clearApproachRoute: true,
               clearEta: true,
               clearCoordination: true,
             );
             _soundService.playAlert();
           } else if (data['status'] == 'started') {
             // The trip is under way. An in-progress ride is only ever flagged
             // for a human, never cancelled on a timer, so none of the delayed-
             // pickup UI may appear from here on.
             state = state.copyWith(
               step: BookingStep.started,
               clearApproachRoute: true,
               clearLastApproachOrigin: true,
               clearEta: true,
               clearDestinationEta: true,
               clearCoordination: true,
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
          // The server says HOW this ended. Reading every cancellation as the
          // passenger's own — which this used to do — tells someone they
          // cancelled a ride the driver or the system closed.
          _handleRideCancelled(data);
          break;
        case 'ride:finished':
          _analytics.log('passenger_trip_completion_received', {
            'rideId': state.rideId,
            'via': 'socket',
          });
          _stopLiveTripMonitor();
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
        // ── Delayed-ride coordination ─────────────────────────────────────
        // Every one of these is a conversation, not a failure. They are all
        // handled through one path so the dedupe rule and the "is this still
        // relevant" checks cannot diverge between event types.
        case 'ride:delay_notice':
        case 'ride:delay_update':
        case 'ride:stale_decision_required':
        case 'ride:cancel_requested':
        case 'ride:delay_escalated':
          _applyCoordinationEvent(data);
          break;
        case 'ride:stale_decision_resolved':
          // Someone chose to keep going — the ride carries on calmly.
          _onCoordinationResolved(
            data,
            stage: CoordinationStage.confirmedEnRoute,
            title: data['message']?.toString() ??
                'Your driver confirmed they are still coming',
            body: 'They are on their way to the pickup point.',
          );
          break;
        case 'ride:cancel_declined':
          _onCoordinationResolved(
            data,
            stage: CoordinationStage.confirmedEnRoute,
            title: data['title']?.toString() ?? 'Your driver is continuing',
            body: data['body']?.toString() ??
                'They have asked to keep the ride and are still on their way.',
          );
          break;
        case 'ride:activity_seen':
          // "Your driver is calling you" beats silence. Purely informational —
          // it never changes what the passenger is being asked.
          _onActivitySeen(data);
          break;
        case 'ride:cancel_request_ack':
          _onCancelRequestAck(data);
          break;
        case 'ride:cancel_response_ack':
        case 'ride:stale_decision_ack':
          _onCoordinationAck(data);
          break;
        case 'ride:error':
          _handleServerError(
            code: data['code']?.toString(),
            message: data['message']?.toString(),
          );
          break;
        case 'driver:location_update':
          _markLiveEvent(location: true);
          _analytics.log('passenger_live_location_received', {
            'rideId': state.rideId,
            'step': state.step.name,
          });
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
    // Awka Main Park. Used only when the device gives us no fix at all — the
    // map has to centre somewhere, and it should be the middle of the city we
    // actually serve.
    //
    // This was 6.1264, 6.7876, which the comment called "Awka fallback" but is
    // 33 km west of it. With location unavailable, the pin — and therefore the
    // default pickup — landed somewhere no park covers and no driver is near.
    final defaultLocation = const LatLng(6.2109, 7.0740);
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

    /*
     * Active-ride recovery is NOT done here any more.
     *
     * It used to be: a partial restore wedged into the middle of map setup,
     * after an `await getCurrentLocation()` — so "Where to?" was painted before
     * the ride was even asked about — and it dropped the driver details and the
     * coordination block that `syncStatus()` knew how to restore. On any error
     * it replaced the screen with a generic failure notice.
     *
     * recoverActiveRide() now runs BEFORE map setup, from the constructor, and
     * again on resume, reconnect and login. See active_ride_recovery.dart.
     */

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
    
    // Structured now, not just a display string. The locality and city are in
    // the same geocoder response the address line is built from, so keeping
    // them costs nothing and is the only moment they are available for free.
    //
    // Guarded, because this is reached from _initializeMap, which is reached
    // from recoverActiveRide. Naming a pin is cosmetic; restoring a passenger's
    // active ride is not. Nothing that happens here may escape into that path.
    ResolvedPlace place;
    try {
      place = await _mapRepo.resolvePlace(target);
    } catch (_) {
      place = ResolvedPlace.unresolved();
    }
    if (!mounted) return;

    if (isPickup && (state.step == BookingStep.selectingPickup ||
        state.step == BookingStep.selectingDestination)) {
      state = state.copyWith(pickupAddress: place.address, pickupPlace: place);
    } else if (!isPickup && state.step == BookingStep.selectingDestinationOnMap) {
      state = state.copyWith(
          destinationAddress: place.address, destinationPlace: place);
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
      // Kept alongside the display strings so the numbers can be reported to the
      // backend for operational monitoring.
      _estimatedDistanceMeters = (estimate['distanceMeters'] as num?)?.round();
      _estimatedDurationSeconds = (estimate['durationSeconds'] as num?)?.round();
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
    /*
     * Never request a ride while the active-ride question is unresolved.
     *
     * If the passenger already has a live ride, the server will refuse with
     * ACTIVE_RIDE_EXISTS — correctly — and the passenger sees a failure for
     * something that was never their mistake. Settle the question first.
     */
    if (_activeRideUnresolved) {
      _analytics.log('stale_home_active_ride_detected', {
        'step': state.step.name,
        'reason': 'booking_attempted_before_recovery_resolved',
      });
      /*
       * Settle it now rather than swallowing the tap. If the answer is "no live
       * ride" the request continues by itself, so the passenger sees a normal
       * booking with a short pause instead of a button that did nothing. If
       * there IS a ride, recovery routes them into it.
       */
      unawaited(recoverActiveRide(RecoverySource.manualRetry).then((r) {
        if (!mounted) return;
        if (r.outcome == RecoveryOutcome.none) _dispatchRequest(isRetry: isRetry);
      }));
      return;
    }
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
    
    // Join the ride room BEFORE emitting the request so no early broadcasts are
    // missed. Registered with the service too, so an auto-reconnect rejoins it —
    // the emit alone is forgotten the moment the socket drops.
    _socketService!.updateActiveRide(rideId);

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
      // Operational telemetry for the admin Live Ride Requests monitor. These
      // estimates were already computed for the fare screen but never sent, so
      // support had no idea how long a trip was meant to take. Never used for
      // pricing or dispatch — the server re-derives anything it charges on.
      if (_estimatedDistanceMeters != null)
        'estimatedDistanceM': _estimatedDistanceMeters,
      if (_estimatedDurationSeconds != null)
        'estimatedDurationSec': _estimatedDurationSeconds,
      // Structured locality for Ride Operations. Spread rather than listed so
      // a field the geocoder did not resolve is ABSENT from the payload — the
      // backend then stores null, and reports can tell "never captured" from
      // "captured as empty". Every key here is optional server-side; a request
      // with none of them validates exactly as it did before.
      ...?state.pickupPlace?.toRequestFields('pickup'),
      ...?state.destinationPlace?.toRequestFields('destination'),
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


  // ═══════════════════════════════════════════════════════════════════
  //  Active-ride recovery — the single authoritative path
  // ═══════════════════════════════════════════════════════════════════

  ActiveRideRecoveryService? _recoveryService;
  bool _recoveryInFlight = false;

  /// True until the first recovery attempt resolves.
  ///
  /// Booking is blocked while this holds, so a passenger cannot create a second
  /// ride in the window before we know whether they already have one.
  bool _activeRideUnresolved = true;
  bool get activeRideUnresolved => _activeRideUnresolved;

  ActiveRideRecoveryService? get _recovery {
    if (_apiClient == null) return null;
    return _recoveryService ??= ActiveRideRecoveryService(_apiClient!.dio, _analytics);
  }

  /// Ask the server whether this passenger has a live ride, and make the app
  /// agree with the answer.
  ///
  /// Every trigger funnels through here — cold start, resume, socket reconnect,
  /// network reconnect, login, notification tap and the ACTIVE_RIDE_EXISTS
  /// fallback. One implementation, so the restored state cannot depend on which
  /// event happened to fire.
  ///
  /// Reentrancy is guarded: a resume that lands at the same moment as a socket
  /// reconnect must not produce two calls racing to write state.
  Future<ActiveRideRecoveryResult> recoverActiveRide(RecoverySource source) async {
    final service = _recovery;
    if (service == null || passengerId == 'unknown') {
      // Not signed in yet. Not a failure — there is nobody to recover for.
      _activeRideUnresolved = false;
      return const ActiveRideRecoveryResult(RecoveryOutcome.none);
    }

    if (_recoveryInFlight) {
      /*
       * A concurrent attempt holds the lock. This used to return immediately
       * WITHOUT scheduling anything — so if the winning attempt had already
       * finished scheduling, this call silently dropped out of the retry chain
       * and nothing ever asked again. Guarantee a follow-up instead.
       */
      _ensureRetryScheduled();
      return const ActiveRideRecoveryResult(
        RecoveryOutcome.failed,
        failure: RecoveryFailure.inFlight,
        error: 'in_flight',
      );
    }

    try {
      /*
       * The flag is set INSIDE the try.
       *
       * It used to be set before it, with a `state = ...` write in between. A
       * StateNotifier write after disposal throws — and the throw skipped the
       * finally, leaving _recoveryInFlight latched true for the life of the
       * controller. Every later attempt then returned `in_flight` immediately
       * and the passenger sat on "Reconnecting to your ride…" for ever.
       */
      _recoveryInFlight = true;
      _recoveryAttempts += 1;
      BootTrace.instance.start(BootStage.activeRideCheck,
          detail: '${source.wire} #$_recoveryAttempts');
      _startRecoveryWatchdog();

      // A cold start shows a restoring state rather than the booking screen.
      // Later triggers leave the current screen alone.
      if (source == RecoverySource.coldStart && state.step == BookingStep.loading) {
        state = state.copyWith(isRestoringRide: true);
      }

      final result = await service.fetch(source: source);
      if (!mounted) return result;

      switch (result.outcome) {
        case RecoveryOutcome.found:
          _lastRecoveryFailure = null;
          _lastRecoveryStatus = result.statusCode;
          BootTrace.instance.success(BootStage.activeRideCheck,
              detail: 'found ${result.snapshot!.status}');
          BootTrace.instance.start(BootStage.hydration);
          _applyRecoveredRide(result.snapshot!, source);
          _activeRideUnresolved = false;
          _recoveryRetryTimer?.cancel();
          break;

        case RecoveryOutcome.none:
          BootTrace.instance.success(BootStage.activeRideCheck, detail: 'none');
          _activeRideUnresolved = false;
          /*
           * A ride we were TRACKING has ended while we were away — clear it.
           *
           * Deliberately limited to the tracking states. A rideId also exists
           * while searching (the client mints one before the server accepts
           * the request), and clearing there would throw away the passenger's
           * chosen pickup and destination the moment a booking was refused.
           */
          const tracking = {
            BookingStep.confirmed, BookingStep.arrived, BookingStep.started,
          };
          if (state.rideId != null && tracking.contains(state.step)) {
            _clearRecoveredRide();
          }
          _recoveryRetryTimer?.cancel();
          state = state.copyWith(isRestoringRide: false, rideRestoreFailed: false);
          // Nothing to restore: let the map lay out the booking flow.
          if (state.step == BookingStep.loading) _initializeMap();
          break;

        case RecoveryOutcome.failed:
          _lastRecoveryFailure = result.failure;
          _lastRecoveryStatus = result.statusCode;
          BootTrace.instance.failure(BootStage.activeRideCheck,
              detail: '${result.failure?.wire ?? 'unknown'}'
                  '${result.statusCode == null ? '' : ' http ${result.statusCode}'}');
          /*
           * We could not ask. Deliberately NOT treated as "no ride": the old
           * code wrote a generic failure notice here and dropped the passenger
           * on the booking screen, which is how somebody with a driver on the
           * way ended up being told "Something went wrong on our end".
           *
           * Keep whatever is on screen, stay unresolved so booking stays
           * blocked, and let the retry triggers handle it.
           */
          state = state.copyWith(
            isRestoringRide: false,
            rideRestoreFailed: true,
          );
          _scheduleRecoveryRetry();
          break;
      }
      return result;
    } finally {
      _recoveryInFlight = false;
      _recoveryWatchdog?.cancel();
      _recoveryWatchdog = null;
    }
  }

  /// Make the app agree with a ride the server says is live.
  void _applyRecoveredRide(ActiveRideSnapshot snap, RecoverySource source) {
    final previousStep = state.step;
    final previousRideId = state.rideId;

    state = state.copyWith(
      step: snap.step,
      rideId: snap.rideId,
      isRestoringRide: false,
      /*
       * Clear the failure flag too.
       *
       * Leaving it set after a SUCCESSFUL recovery kept the retry timer's guard
       * (`!rideRestoreFailed`) permanently true, so the retry loop carried on
       * firing for the rest of the ride — re-querying the server every few
       * seconds forever.
       */
      rideRestoreFailed: false,
      // Never carry a stale error into a restored ride.
      clearNotice: true,
      pickupLocation: (snap.pickupLat != null && snap.pickupLng != null)
          ? LatLng(snap.pickupLat!, snap.pickupLng!)
          : state.pickupLocation,
      pickupAddress: snap.pickupAddress ?? state.pickupAddress,
      destinationLocation: (snap.destinationLat != null && snap.destinationLng != null)
          ? LatLng(snap.destinationLat!, snap.destinationLng!)
          : state.destinationLocation,
      destinationAddress: snap.destinationAddress ?? state.destinationAddress,
      estimatedFareAmount: snap.fare ?? state.estimatedFareAmount,
      // Driver details come from the same payload. The old recovery ignored
      // them, so a restored ride showed a tracking screen with no driver on it.
      assignedDriver: snap.driverDetails ?? state.assignedDriver,
      pickupCode: snap.pickupCode ?? state.pickupCode,
      paymentMethod: snap.paymentMode ?? state.paymentMethod,
    );

    /*
     * ── Layered hydration ────────────────────────────────────────────
     * Everything above is LEVEL 1 — rideId, status, pickup, destination,
     * driver identity. It is already applied, so the ride screen can render
     * from here whatever happens next.
     *
     * Everything below is Level 2 and 3: coordination, the route line, the
     * socket room. Each is wrapped, because one optional field must never cost
     * the passenger the ride. A coordination block the parser cannot read used
     * to throw out of this method with the ride only half applied.
     */
    try {
      _applyRecoveredCoordination(snap.coordination);
    } catch (e) {
      _analytics.log('active_ride_hydration_partial', {
        'rideId': snap.rideId, 'level': 2, 'field': 'coordination',
      });
    }

    /*
     * Join the ride room.
     *
     * updateActiveRide() had zero callers anywhere in the app, so the socket
     * never subscribed to `ride:<id>` and the auto-rejoin-on-reconnect logic
     * inside SocketService could never fire — it was guarding a field nothing
     * ever set. Driver location updates and chat both broadcast to that room.
     */
    /*
     * Level 3. The socket is an ENHANCEMENT: the ride screen is already
     * rendered from the REST snapshot above and must never wait for a
     * connection, a room join, the map, directions, GPS or Firebase.
     */
    try {
      _socketService?.updateActiveRide(snap.rideId);
    } catch (e) {
      _analytics.log('active_ride_hydration_partial', {
        'rideId': snap.rideId, 'level': 3, 'field': 'socket_room',
      });
    }

    if (snap.step == BookingStep.searching) {
      _startWatchdog();
      _startSearchingKekeFeed();
    } else {
      _stopWatchdog();
    }

    /*
     * Draw the route, but do NOT call _calculateFare().
     *
     * That method clears estimatedFareAmount before it starts and raises an
     * `invalidRoute` notice if routing fails — so on a restored ride it would
     * discard the server's authoritative fare and put a red error banner over a
     * trip that is proceeding perfectly well.
     */
    /*
     * Redraw the route only when it is actually missing or the ride has moved
     * to a new stage.
     *
     * The live-trip monitor reconciles every 20 seconds while a ride is
     * running, and this method runs on every one of those. Refetching
     * directions each time would mean three paid Directions calls a minute,
     * per passenger, for a line that has not changed.
     */
    // Level 3. Fire-and-forget and already silent on failure.
    if (state.activeRoutePolyline.isEmpty || previousStep != snap.step) {
      unawaited(_restoreRoutePolyline());
    }

    // Reconciliation is worth its own event: it is the proof that the app
    // caught up with something that happened while it was dead.
    BootTrace.instance.success(BootStage.hydration,
        detail: 'level1 ok, step ${snap.step.name}');

    if (previousRideId == snap.rideId && previousStep != snap.step) {
      _analytics.log('active_ride_recovery_reconciled', {
        'source': source.wire,
        'rideId': snap.rideId,
        'from': previousStep.name,
        'to': snap.step.name,
        'status': snap.status,
      });
    }
  }

  /// Redraw the route line for a restored ride. Cosmetic, and silent on
  /// failure: the fare and the ride state came from the server and must not be
  /// disturbed by a map lookup that did not work.
  Future<void> _restoreRoutePolyline() async {
    final from = state.pickupLocation;
    final to = state.destinationLocation;
    if (from == null || to == null) return;
    try {
      final estimate = await _mapRepo.calculateRouteAndFare(from, to);
      if (!mounted) return;
      state = state.copyWith(
        activeRoutePolyline: List<LatLng>.from(estimate['polyline']),
        estimatedDistance: estimate['distance'] as String?,
        estimatedTime: estimate['time'] as String?,
      );
    } catch (_) {
      // No route line. The ride is unaffected.
    }
  }

  void _applyRecoveredCoordination(Map<String, dynamic>? block) {
    if (block == null) {
      if (state.coordination != null) state = state.copyWith(clearCoordination: true);
      return;
    }
    final parsed = RideCoordination.fromWire(block, role: 'passenger');
    if (parsed == null) {
      if (state.coordination != null) state = state.copyWith(clearCoordination: true);
      return;
    }
    _rememberCoordinationEvent(parsed.eventId);
    state = state.copyWith(
      coordination: parsed.copyWith(
        answered: !parsed.decisionOpen && parsed.decidedByMe,
      ),
    );
  }

  /// A ride that has become terminal while we were away. Idempotent.
  void _clearRecoveredRide() {
    _stopWatchdog();
    _socketService?.updateActiveRide(null);
    /*
     * There is no persistent local ride notification to clear: the app depends
     * on firebase_messaging only and has no local-notification plugin. When one
     * is added, cancelling it belongs here — this is the single terminal-cleanup
     * path and it is already idempotent.
     */
    state = state.copyWith(
      step: BookingStep.idle,
      clearRideId: true,
      clearAssignedDriver: true,
      clearCoordination: true,
      isRestoringRide: false,
    );
  }

  Timer? _recoveryRetryTimer;
  Timer? _recoveryWatchdog;
  int _recoveryAttempts = 0;
  RecoveryFailure? _lastRecoveryFailure;
  int? _lastRecoveryStatus;

  /// Attempts made since launch. Shown on the field-test strip.
  int get recoveryAttempts => _recoveryAttempts;
  RecoveryFailure? get lastRecoveryFailure => _lastRecoveryFailure;
  int? get lastRecoveryStatus => _lastRecoveryStatus;

  /// The recovery question has been open for too long.
  ///
  /// A request that never completes — a socket held open by a captive portal,
  /// a TLS handshake that stalls — leaves the passenger on the restoring screen
  /// with no error and no retry, because the `finally` that schedules the next
  /// attempt never runs. The watchdog breaks that.
  static const Duration recoveryWatchdogTimeout = Duration(seconds: 12);

  void _startRecoveryWatchdog() {
    _recoveryWatchdog?.cancel();
    _recoveryWatchdog = Timer(recoveryWatchdogTimeout, () {
      if (!mounted) return;
      _analytics.log('active_ride_recovery_stuck', {
        'attempt': _recoveryAttempts,
        'step': state.step.name,
        'seconds': recoveryWatchdogTimeout.inSeconds,
      });
      /*
       * Release the lock and try again. Deliberately does NOT send the
       * passenger to "Where to?" — an unresolved recovery is not the same as
       * no active ride, and that mistake is the whole bug this system exists
       * to prevent.
       */
      _recoveryInFlight = false;
      _ensureRetryScheduled(immediate: true);
    });
  }

  /// Guarantee that another attempt is coming.
  ///
  /// Idempotent: if a retry is already armed it is left alone, so overlapping
  /// callers cannot cancel each other's timer and leave the chain dead.
  void _ensureRetryScheduled({bool immediate = false}) {
    if (_recoveryRetryTimer?.isActive == true && !immediate) return;
    _recoveryRetryTimer?.cancel();
    // Bounded backoff: 2s, 4s, 8s… capped at 15s. A phone that has just woken
    // often has no usable network for a few seconds, and hammering it helps
    // nobody.
    final seconds = immediate
        ? 1
        : (2 << (_recoveryAttempts.clamp(0, 3))).clamp(2, 15);
    _recoveryRetryTimer = Timer(Duration(seconds: seconds), () {
      if (!mounted) return;
      if (!_activeRideUnresolved && !state.rideRestoreFailed) return;
      recoverActiveRide(RecoverySource.manualRetry);
    });
  }

  /// The passenger pressed "Try again".
  Future<void> retryActiveRideRecovery() async {
    _recoveryRetryTimer?.cancel();
    // A manual press must never be swallowed by a stuck lock.
    if (_recoveryWatchdog?.isActive != true) _recoveryInFlight = false;
    await recoverActiveRide(RecoverySource.manualRetry);
  }

  /// Retry a failed check on a short backoff.
  ///
  /// A phone that has just woken up frequently has no usable network for a few
  /// seconds. Retrying quietly is far better than asking the passenger to do
  /// anything, and far better than guessing that they have no ride.
  void _scheduleRecoveryRetry() => _ensureRetryScheduled(immediate: true);


  // ═══════════════════════════════════════════════════════════════════
  //  Live-trip monitor
  // ═══════════════════════════════════════════════════════════════════
  //
  //  ── The failure this exists for ──────────────────────────────────
  //  Socket.IO rooms are per-CONNECTION. Every reconnect drops them. The
  //  passenger joins `ride:<id>` once, when the ride is requested; a single
  //  network blip — a cell handover on a moving Keke, a screen lock, a WiFi
  //  switch — silently removes them from that room for the rest of the trip.
  //
  //  `driver:location_update` and `ride:finished` are both broadcast to that
  //  room. So the marker freezes, the ETA stops falling, and the completion
  //  event never lands: the passenger sits on an in-progress screen for a trip
  //  that ended. Restarting the app fixes it, because a fresh socket rejoins.
  //
  //  Room membership is now re-asserted, but "the rejoin worked" is not
  //  something a client can assume. This watches the stream and repairs it.
  //
  //  ── Why the old watchdog did not catch it ────────────────────────
  //  It ran only while `searching`, and `_stopWatchdog()` fires on
  //  `ride:assigned`. From assignment to completion there was no
  //  reconciliation of any kind.

  Timer? _liveTripTimer;
  DateTime? _lastDriverLocationAt;
  DateTime? _lastRideEventAt;

  /// How often the authoritative state is re-read during a live ride.
  ///
  /// 20s: frequent enough that a missed completion is corrected before a
  /// passenger notices, infrequent enough to be three requests a minute for a
  /// passenger who is, by definition, in a Keke. The socket remains primary;
  /// this is the safety net.
  static const Duration liveReconcileInterval = Duration(seconds: 20);

  /// No driver location for this long during a moving trip means the stream is
  /// broken, not quiet. Drivers publish on every heartbeat.
  static const Duration liveLocationStaleAfter = Duration(seconds: 30);

  /// Steps during which the live stream must be flowing.
  static const _trackingSteps = {
    BookingStep.confirmed, BookingStep.arrived, BookingStep.started,
  };

  bool get _isTrackingRide => _trackingSteps.contains(state.step);

  void _startLiveTripMonitor() {
    if (_liveTripTimer != null) return;
    _lastRideEventAt = DateTime.now();
    _analytics.log('passenger_ride_room_joined', {
      'rideId': state.rideId,
      'step': state.step.name,
    });
    _liveTripTimer = Timer.periodic(liveReconcileInterval, (_) => _liveTripTick());
  }

  void _stopLiveTripMonitor() {
    _liveTripTimer?.cancel();
    _liveTripTimer = null;
    _lastDriverLocationAt = null;
    _lastRideEventAt = null;
  }

  /// Age of the live stream, or null if nothing has arrived yet.
  Duration? get _sinceLastLocation => _lastDriverLocationAt == null
      ? null
      : DateTime.now().difference(_lastDriverLocationAt!);

  Future<void> _liveTripTick() async {
    if (!mounted || !_isTrackingRide) {
      _stopLiveTripMonitor();
      return;
    }

    final socketDown = !(_socketService?.isConnected ?? false);
    final since = _sinceLastLocation;
    // Only the moving stages expect a location stream. A driver waiting at the
    // pickup point may legitimately not move, but their heartbeat still runs,
    // so the check holds for `arrived` too.
    final locationStale = since != null && since > liveLocationStaleAfter;

    if (socketDown || locationStale) {
      _analytics.log('passenger_live_location_stale', {
        'rideId': state.rideId,
        'step': state.step.name,
        'socketConnected': !socketDown,
        'secondsSinceLocation': since?.inSeconds,
      });

      // 1. Get the link back. 2. Re-assert the rooms on it — a reconnect the
      // client never noticed leaves it in no room at all.
      _socketService?.reconnect();
      _socketService?.rejoinRooms();
      _analytics.log('passenger_ride_room_rejoined', {'rideId': state.rideId});

      if (!state.liveStreamStale) {
        state = state.copyWith(liveStreamStale: true);
      }
    }

    // The reconciliation heartbeat. Runs every tick, stale or not: this is what
    // catches a completion event that was broadcast to a room we had silently
    // left, which is the symptom that left passengers on a finished trip.
    final result = await recoverActiveRide(RecoverySource.liveTripReconcile);
    if (!mounted) return;

    if (result.resolved) {
      state = state.copyWith(
        liveStreamStale: false,
        lastReconciledAt: DateTime.now(),
      );
      _analytics.log('passenger_trip_reconciled', {
        'rideId': state.rideId,
        'step': state.step.name,
        'outcome': result.outcome.name,
        // Lets operations separate a stale passenger socket from a driver
        // whose phone stopped publishing. Both freeze the same map.
        'driverGpsAgeSeconds': result.snapshot?.driverGpsAgeSeconds,
      });
    }
  }

  /// Everything a field tester needs to explain a stuck screen, in one object.
  ///
  /// Read by the diagnostics overlay, which is compiled in only when
  /// `--dart-define=FIELD_TEST=true`. Contains no passenger identity: a rideId,
  /// coordinates and timings, nothing that names a person.
  LiveTripDiagnostics get liveDiagnostics => LiveTripDiagnostics(
        rideId: state.rideId,
        step: state.step.name,
        socketConnected: _socketService?.isConnected ?? false,
        joinedRideRoom: _socketService?.activeRideRoom,
        driverLocation: state.assignedDriverLocation,
        lastLocationAt: _lastDriverLocationAt,
        lastRideEventAt: _lastRideEventAt,
        lastReconciledAt: state.lastReconciledAt,
        remainingMeters: state.step == BookingStep.started
            ? state.distanceToDestinationMeters
            : state.distanceToPickupMeters,
        etaMinutes: state.step == BookingStep.started
            ? state.etaToDestinationMinutes
            : state.etaMinutes,
        streamStale: state.liveStreamStale,
        monitorRunning: _liveTripTimer != null,
      );

  /// Record that something arrived on the live stream.
  void _markLiveEvent({bool location = false}) {
    final now = DateTime.now();
    _lastRideEventAt = now;
    if (location) {
      _lastDriverLocationAt = now;
      if (state.liveStreamStale) {
        state = state.copyWith(liveStreamStale: false);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Persistent ride notification
  // ═══════════════════════════════════════════════════════════════════

  /// Keep the Android status-bar entry in step with the ride.
  ///
  /// Called from exactly one place — [_afterStateChanged] — so the notification
  /// cannot drift from the state. Every path that changes the ride goes through
  /// the same funnel, including recovery, socket events and terminal cleanup.
  ///
  /// Fire-and-forget: a notification that fails to post must never interrupt a
  /// ride.
  void _syncRideNotification() {
    final driver = state.assignedDriver;
    unawaited(RideStatusNotification.instance.show(
      state.step,
      driverName: driver?['name']?.toString(),
      destination: state.destinationAddress,
    ));
  }

  /// The app came back to the foreground. Called by the lifecycle observer.
  Future<void> onAppResumed() => recoverActiveRide(RecoverySource.appResume);

  /// Connectivity returned.
  Future<void> onNetworkRestored() => recoverActiveRide(RecoverySource.networkReconnect);

  /// Re-read the server and heal whatever drifted.
  ///
  /// Delegates to [recoverActiveRide] rather than carrying its own copy of the
  /// parsing and mapping. It used to be a second, subtly different
  /// implementation — and critically it began with
  /// `if (state.rideId == null) return;`, which made it a no-op in the one
  /// situation that matters most: after process death, when there is no local
  /// rideId to check against.
  Future<void> syncStatus({RecoverySource source = RecoverySource.socketReconnect}) async {
    // A receipt is showing. The ride is over; do not disturb it.
    if (state.step == BookingStep.completed) return;
    await recoverActiveRide(source);
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

  // ── Delayed-ride coordination ──────────────────────────────────────────
  //
  // The passenger's half of the human-centred recovery model. A delay means two
  // people are still trying to meet; the app's job is to carry the conversation
  // and report what the passenger chooses, never to decide that a ride has failed.

  /// Coordination moments already shown. Keyed on the server's deterministic
  /// `eventId`, so a socket event and the push notification that follows it are
  /// one prompt, and a reconnect that replays an event does not ask twice.
  final Set<String> _seenCoordinationEvents = <String>{};

  /// Bounded so a very long ride cannot grow this without limit.
  static const int _maxRememberedCoordinationEvents = 64;

  bool _rememberCoordinationEvent(String eventId) {
    if (_seenCoordinationEvents.contains(eventId)) return false;
    if (_seenCoordinationEvents.length >= _maxRememberedCoordinationEvents) {
      _seenCoordinationEvents.remove(_seenCoordinationEvents.first);
    }
    _seenCoordinationEvents.add(eventId);
    return true;
  }

  /// Apply an inbound coordination event.
  ///
  /// Refuses anything that is not about the current ride, and anything about a
  /// trip already under way — the backend never cancels those on a timer, so
  /// showing a decision prompt would describe something that cannot happen.
  void _applyCoordinationEvent(Map<String, dynamic> data) {
    final rideId = data['rideId']?.toString();
    if (rideId == null || rideId != state.rideId) return;
    if (state.step == BookingStep.started ||
        state.step == BookingStep.completed) {
      return;
    }

    final parsed = RideCoordination.fromWire(data, role: 'passenger');
    if (parsed == null) return;

    final fresh = _rememberCoordinationEvent(parsed.eventId);
    // A duplicate must not resurrect a prompt the passenger already answered, but
    // it also must not be dropped when it is genuinely new information about the
    // same moment (a reminder repeating an escalation, say).
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
      // Only an open question earns a sound. A calm status update does not.
      if (parsed.needsAnswer) _soundService.playAlert();
    }
  }

  /// Someone answered, or the situation calmed down. Keeps a low-key status card
  /// so the passenger is not left wondering what happened to the question.
  void _onCoordinationResolved(
    Map<String, dynamic> data, {
    required CoordinationStage stage,
    required String title,
    required String body,
  }) {
    final rideId = data['rideId']?.toString();
    if (rideId == null || rideId != state.rideId) return;
    final existing = state.coordination;
    state = state.copyWith(
      coordination: RideCoordination(
        rideId: rideId,
        stage: stage,
        title: title,
        body: body,
        eventId: data['eventId']?.toString() ??
            '$rideId:${stage.wire}:resolved',
        rideStatus: existing?.rideStatus ?? 'accepted',
        // Nothing is being asked any more, so no countdown and no answer buttons.
        decisionOpen: false,
        extensionsRemaining: existing?.extensionsRemaining ?? 0,
        actions: const [
          CoordinationAction.callOtherParty,
          CoordinationAction.requestCancel,
        ],
      ),
    );
    _analytics.logCoordination('prompt_resolved',
        rideId: rideId,
        eventId: data['eventId']?.toString(),
        stage: stage.wire,
        extra: {'decidedBy': data['decidedBy']?.toString()});
  }

  void _onActivitySeen(Map<String, dynamic> data) {
    if (data['rideId']?.toString() != state.rideId) return;
    if (data['by']?.toString() != 'driver') return;
    final type = data['type']?.toString();
    final text = switch (type) {
      'driver_called_passenger' => 'Your driver is trying to call you.',
      'driver_still_coming' => 'Your driver confirmed they are still coming.',
      'chat_message' => 'Your driver sent you a message.',
      _ => null,
    };
    if (text == null) return;
    state = state.copyWith(errorMessage: text);
    _scheduleErrorClear(seconds: 6);
  }

  /// Our own cancellation request was accepted for delivery. The ride stays
  /// active — a request is not a cancellation — so this only switches the card to
  /// a pending state with the server's deadline.
  void _onCancelRequestAck(Map<String, dynamic> data) {
    final rideId = data['rideId']?.toString();
    if (rideId == null || rideId != state.rideId) return;

    if (data['accepted'] != true) {
      final reason = data['reason']?.toString();
      state = state.copyWith(
        coordination: state.coordination?.copyWith(submitting: false),
        errorMessage: reason == 'request_already_pending'
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
        body: 'We have asked your driver. Your ride stays active until they answer.',
        eventId: data['eventId']?.toString() ?? '$rideId:cancel_request_pending',
        respondByAt: deadline?.toUtc(),
        cancellationRequestedBy: 'passenger',
        cancellationRequestState: 'pending',
        requestedByMe: true,
        rideStatus: state.coordination?.rideStatus ?? 'accepted',
        actions: const [CoordinationAction.callOtherParty],
      ),
    );
    _analytics.logCoordination('cancellation_requested',
        rideId: rideId,
        eventId: data['eventId']?.toString(),
        stage: CoordinationStage.cancellationRequested.wire,
        extra: {'awaiting': data['awaiting']?.toString()});
  }

  /// The server's verdict on a response we sent. It is authoritative: a refusal
  /// here means the answer did not land, whatever the UI was showing.
  void _onCoordinationAck(Map<String, dynamic> data) {
    final rideId = data['rideId']?.toString();
    if (rideId == null || rideId != state.rideId) return;
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

    // Rejections are shown honestly rather than swallowed. "Already decided"
    // means the other person got there first; that is worth knowing, and it is
    // not an error.
    final reason = data['reason']?.toString();
    final message = switch (reason) {
      'already_decided' => 'Your driver already answered this one.',
      'extension_limit_reached' => data['message']?.toString() ??
          'You have already chosen to wait once on this ride.',
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
    // Re-read the truth: whatever we thought was open probably is not.
    refreshCoordination();
  }

  /// Act on the passenger's choice.
  ///
  /// Everything that changes the ride goes to the server and waits for its
  /// answer. Nothing is applied locally on the optimistic assumption that it
  /// worked — a ride the app thinks is cancelled but the server still has live is
  /// how a passenger ends up unable to book.
  void respondToCoordination(CoordinationAction action) {
    final current = state.coordination;
    final rideId = state.rideId;
    if (current == null || rideId == null) return;
    // One answer at a time. Guards the double-tap.
    if (current.submitting) return;

    switch (action) {
      case CoordinationAction.stillComing:
      case CoordinationAction.openNavigation:
      case CoordinationAction.shareLocation:
        // Driver-side actions; nothing for the passenger app to do.
        return;

      case CoordinationAction.keepWaiting:
      case CoordinationAction.continueRide:
        _sendCoordinationChoice(current, rideId, action);
        return;

      case CoordinationAction.onMyWay:
        // Acknowledgement that the passenger is coming out. Recorded as intent,
        // so it extends the window and the driver sees it.
        state = state.copyWith(
          coordination: current.copyWith(submitting: true),
        );
        _socketService?.emit('ride:activity', {
          'rideId': rideId,
          'userId': passengerId,
          'role': 'passenger',
          'type': 'passenger_keep_waiting',
        });
        // No ack event exists for ride:activity, so settle the UI locally. The
        // ride state itself is untouched, so there is nothing to be wrong about.
        state = state.copyWith(
          coordination: current.copyWith(
            submitting: false,
            answered: true,
            decisionOpen: false,
            title: 'Your driver knows you are coming',
            body: 'Please meet them at the pickup point.',
          ),
        );
        _analytics.logCoordination('passenger_acknowledged_coming',
            rideId: rideId, eventId: current.eventId, stage: current.stage.wire);
        return;

      case CoordinationAction.acceptCancellation:
        state = state.copyWith(coordination: current.copyWith(submitting: true));
        _socketService?.emit('ride:cancel_response', {
          'rideId': rideId,
          'userId': passengerId,
          'role': 'passenger',
          'decision': 'accept',
        });
        _analytics.logCoordination('cancellation_accepted',
            rideId: rideId, eventId: current.eventId, stage: current.stage.wire);
        return;

      case CoordinationAction.requestCancel:
        state = state.copyWith(coordination: current.copyWith(submitting: true));
        // A request, not a cancellation. The driver still gets to answer, and the
        // ride stays live until the backend says otherwise.
        _socketService?.emit('ride:cancel_request', {
          'rideId': rideId,
          'userId': passengerId,
          'role': 'passenger',
        });
        return;

      case CoordinationAction.findAnotherDriver:
        // Only offered once the backend has escalated, i.e. it has given up
        // reaching the driver. Still a request the driver may answer.
        state = state.copyWith(coordination: current.copyWith(submitting: true));
        _socketService?.emit('ride:cancel_request', {
          'rideId': rideId,
          'userId': passengerId,
          'role': 'passenger',
        });
        _analytics.logCoordination('find_another_keke',
            rideId: rideId, eventId: current.eventId, stage: current.stage.wire);
        return;

      case CoordinationAction.callOtherParty:
        // The dial itself is the UI's job (a tel: link). Reporting it here is what
        // makes it count as evidence the ride is alive — the server cannot see a
        // phone call.
        _socketService?.emit('ride:activity', {
          'rideId': rideId,
          'userId': passengerId,
          'role': 'passenger',
          'type': 'passenger_called_driver',
        });
        _analytics.logCoordination('call_used',
            rideId: rideId, eventId: current.eventId, stage: current.stage.wire);
        return;

      case CoordinationAction.messageOtherParty:
        _analytics.logCoordination('message_used',
            rideId: rideId, eventId: current.eventId, stage: current.stage.wire);
        return;

      case CoordinationAction.contactSupport:
        _analytics.logCoordination('support_opened',
            rideId: rideId, eventId: current.eventId, stage: current.stage.wire);
        return;
    }
  }

  void _sendCoordinationChoice(
    RideCoordination current,
    String rideId,
    CoordinationAction action,
  ) {
    state = state.copyWith(coordination: current.copyWith(submitting: true));

    if (current.stage == CoordinationStage.cancellationRequested &&
        !current.requestedByMe) {
      // Declining a cancellation request is its own event.
      _socketService?.emit('ride:cancel_response', {
        'rideId': rideId,
        'userId': passengerId,
        'role': 'passenger',
        'decision': 'continue',
      });
      _analytics.logCoordination('cancellation_declined',
          rideId: rideId, eventId: current.eventId, stage: current.stage.wire);
      return;
    }

    _socketService?.emit('ride:stale_decision', {
      'rideId': rideId,
      'userId': passengerId,
      'role': 'passenger',
      'choice': 'wait',
    });
    _analytics.logCoordination('continue_waiting',
        rideId: rideId, eventId: current.eventId, stage: current.stage.wire);
  }

  /// Re-read the authoritative coordination state.
  ///
  /// Called on launch, on reconnect and after a rejected response. This is what
  /// makes a prompt survive a process restart and — just as important — what stops
  /// a prompt that has already been answered from coming back.
  Future<void> refreshCoordination() async {
    final rideId = state.rideId;
    if (_apiClient == null || rideId == null) return;
    try {
      final response = await _apiClient!.dio.get('/rides/$rideId/coordination');
      if (!mounted || state.rideId != rideId) return;

      final data = response.data;
      final block = data is Map ? data['coordination'] : null;
      if (block is! Map) {
        // Server says there is nothing to coordinate. Believe it.
        if (state.coordination != null) {
          state = state.copyWith(clearCoordination: true);
        }
        return;
      }

      final parsed = RideCoordination.fromWire(
        block.map((k, v) => MapEntry(k.toString(), v)),
        role: 'passenger',
      );
      if (parsed == null) {
        state = state.copyWith(clearCoordination: true);
        return;
      }

      // Anything the server still considers open is worth showing again after a
      // restart; anything resolved is recorded as seen so a replayed socket event
      // cannot re-prompt.
      _rememberCoordinationEvent(parsed.eventId);
      state = state.copyWith(
        coordination: parsed.copyWith(
          answered: !parsed.decisionOpen && parsed.decidedByMe,
        ),
      );
    } catch (e) {
      print('[PASSENGER] Coordination refresh failed: $e');
    }
  }

  /// A ride ended. The server classifies how; the app only renders it.
  void _handleRideCancelled(Map<String, dynamic> data) {
    final rideId = data['rideId']?.toString();
    // A dismissal for a different ride must not tear down this one.
    if (rideId != null && state.rideId != null && rideId != state.rideId) return;

    print('[PASSENGER_SYNC] Ride cancelled (${data['outcome']}). Resetting state.');
    _searchTimeoutTimer?.cancel();
    _stopWatchdog();

    final closure = RideClosure.fromWire(data['outcome']?.toString());
    final title = data['title']?.toString();
    final body = data['body']?.toString();

    _analytics.logCoordination('ride_closed',
        rideId: rideId,
        eventId: data['eventId']?.toString(),
        stage: 'closed',
        extra: {'outcome': closure.name, 'reasonCode': data['reason']?.toString()});

    // Only two outcomes are genuinely the passenger's own doing, and only those
    // may use the "you cancelled this ride" notice. Everything else — the driver
    // could not make it, nobody answered, support closed it — gets a card that
    // explains what happened and offers a way forward. Listing the exceptions
    // rather than the rule is how the original defect happened: an outcome nobody
    // had thought about fell through to "you cancelled".
    final isOwnCancellation = closure == RideClosure.cancelledByPassenger ||
        closure == RideClosure.cancelled;

    if (!isOwnCancellation) {
      _resetBookingState();
      state = state.copyWith(
        closure: closure,
        closureTitle: title ?? 'Ride closed',
        closureBody: body ?? _defaultClosureBody(closure),
      );
      return;
    }

    _reportOutcome(RideOutcome.passengerCancelled,
        dispatchResult: data['reason']?.toString() ?? 'passenger_cancelled');
    _resetBookingState(
        notice: BookingNotice.of(RideOutcome.passengerCancelled));
    _scheduleNoticeClear(seconds: 8);
  }

  static String _defaultClosureBody(RideClosure closure) => switch (closure) {
        RideClosure.closedNoResponse =>
          "This ride was closed because we couldn't reach either you or the driver.",
        RideClosure.cancelledRequestUnanswered =>
          'The cancellation went ahead because there was no answer. You can book again now.',
        RideClosure.cancelledByDriver =>
          'Your driver could not complete this pickup. You can book another Keke now.',
        RideClosure.resolvedBySupport =>
          'Our team closed this ride. Please contact support if you need anything else.',
        _ => 'This ride has been cancelled. You can book again now.',
      };

  /// Dismiss the closing card and get back to booking.
  void dismissClosure() {
    if (state.closure == null) return;
    state = state.copyWith(clearClosure: true);
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

    /*
     * ACTIVE_RIDE_EXISTS is not an error to show the passenger — it is the
     * server telling us we have forgotten a ride the passenger is still on.
     * The guard is correct; our screen was stale.
     *
     * Recover into the real ride instead of rendering "Something went wrong".
     * This is a safety net: proper cold-start recovery should mean the
     * passenger never reaches a booking screen with a live ride outstanding,
     * and `stale_home_active_ride_detected` exists so we can tell whether that
     * is actually holding in the field.
     */
    if (outcome == RideOutcome.activeRideExists) {
      _analytics.log('stale_home_active_ride_detected', {
        'step': state.step.name,
        'hadLocalRideId': state.rideId != null,
      });
      _searchTimeoutTimer?.cancel();
      _stopWatchdog();
      unawaited(recoverActiveRide(RecoverySource.activeRideExistsFallback).then((r) {
        if (!mounted) return;
        if (r.found) return; // routed into the real ride; nothing to report

        /*
         * The two answers disagree: the dispatcher refused because a ride
         * exists, but the active-ride endpoint says there is none. Rare — a
         * ride ending in the moment between the two calls does it — and we
         * cannot restore something the server will not describe.
         *
         * Fall back to the honest, informative notice rather than leaving the
         * passenger on a spinner. It is not the generic "something went wrong":
         * it says a ride is already in progress, which is what the server just
         * told us.
         */
        _reportOutcome(outcome, dispatchResult: 'server_rejected');
        state = state.copyWith(
          step: state.step == BookingStep.searching
              ? BookingStep.previewEstimate
              : state.step,
          notice: BookingNotice.of(outcome, dispatchResult: 'server_rejected'),
        );
        _scheduleNoticeClear();
      }));
      return;
    }

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

  /// Cancel the current booking.
  ///
  /// [reasonCode] is one of the server's PASSENGER_CANCEL_REASONS and is
  /// stored on the ride so Operations can count why passengers cancel.
  /// Optional so nothing else that calls this has to change; the server keeps
  /// its old generic value when none is sent.
  ///
  /// This performs the cancellation immediately — the confirmation flow lives
  /// in the UI, and by the time we get here the passenger has chosen a reason
  /// and confirmed a destructive action.
  void cancelBooking({String? reasonCode}) {
    // Trip already in progress — cancellation not allowed
    if (state.step == BookingStep.started) return;
    if (_socketService != null && state.rideId != null) {
      print('[PASSENGER_LIFECYCLE] Requesting cancellation for: ${state.rideId}');
      state = state.copyWith(step: BookingStep.loading);

      _socketService!.emit('ride:cancel', {
        'rideId': state.rideId,
        'passengerId': passengerId,
        if (reasonCode != null) 'reason': reasonCode,
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
