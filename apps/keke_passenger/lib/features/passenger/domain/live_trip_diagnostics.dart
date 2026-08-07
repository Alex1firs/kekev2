import 'package:google_maps_flutter/google_maps_flutter.dart';

/// A snapshot of the live-trip stream, for field testing.
///
/// Exists because "the marker stopped moving" is not a diagnosis. It could be
/// a dead socket, a room the client silently left, a driver whose GPS stopped,
/// or a passenger app that received updates and failed to render them — and
/// from the outside all four look identical.
///
/// Deliberately free of passenger identity: a rideId, coordinates and timings.
/// Nothing here names a person, so a screenshot from a field test can be pasted
/// into a chat without leaking anything.
class LiveTripDiagnostics {
  const LiveTripDiagnostics({
    required this.rideId,
    required this.step,
    required this.socketConnected,
    required this.joinedRideRoom,
    required this.driverLocation,
    required this.lastLocationAt,
    required this.lastRideEventAt,
    required this.lastReconciledAt,
    required this.remainingMeters,
    required this.etaMinutes,
    required this.streamStale,
    required this.monitorRunning,
  });

  final String? rideId;
  final String step;
  final bool socketConnected;

  /// The ride room the socket believes it is in. Null here while a ride is
  /// running is the single most diagnostic value in this object — it is the
  /// state that produced the frozen-marker reports.
  final String? joinedRideRoom;

  final LatLng? driverLocation;
  final DateTime? lastLocationAt;
  final DateTime? lastRideEventAt;
  final DateTime? lastReconciledAt;
  final double? remainingMeters;
  final double? etaMinutes;
  final bool streamStale;
  final bool monitorRunning;

  int? get secondsSinceLocation => lastLocationAt == null
      ? null
      : DateTime.now().difference(lastLocationAt!).inSeconds;

  int? get secondsSinceRideEvent => lastRideEventAt == null
      ? null
      : DateTime.now().difference(lastRideEventAt!).inSeconds;

  int? get secondsSinceReconcile => lastReconciledAt == null
      ? null
      : DateTime.now().difference(lastReconciledAt!).inSeconds;

  /// True when the room membership that carries driver locations is missing
  /// while a ride is live — the condition behind the field report.
  bool get roomMembershipSuspect => rideId != null && joinedRideRoom == null;

  Map<String, Object?> toMap() => {
        'rideId': rideId,
        'step': step,
        'socketConnected': socketConnected,
        'joinedRideRoom': joinedRideRoom,
        'roomMembershipSuspect': roomMembershipSuspect,
        'driverLat': driverLocation?.latitude,
        'driverLng': driverLocation?.longitude,
        'secondsSinceLocation': secondsSinceLocation,
        'secondsSinceRideEvent': secondsSinceRideEvent,
        'secondsSinceReconcile': secondsSinceReconcile,
        'remainingMeters': remainingMeters?.round(),
        'etaMinutes': etaMinutes?.round(),
        'streamStale': streamStale,
        'monitorRunning': monitorRunning,
      };
}
