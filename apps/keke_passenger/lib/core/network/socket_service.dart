import 'dart:async';
import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:socket_io_client/socket_io_client.dart' as IO;
import '../config/env_config.dart';

class SocketService {
  IO.Socket? _socket;
  final String _role;
  final String _userId;
  String? _activeRideId;

  final _controller = StreamController<Map<String, dynamic>>.broadcast();
  Stream<Map<String, dynamic>> get events => _controller.stream;

  final String _token;

  SocketService(this._role, this._userId, this._token) {
    _initSocket();
  }

  /// Test seam: a service with no real socket. Connectivity is fixed by
  /// [connected], inbound events come from [injectEvent], and outbound ones are
  /// recorded in [sentEvents] instead of hitting the network.
  @visibleForTesting
  SocketService.offline({bool connected = true})
      : _role = 'passenger',
        _userId = 'test-passenger',
        _token = '',
        _forcedConnected = connected;

  bool? _forcedConnected;

  /// Outbound emits captured by [SocketService.offline]. Always empty in prod.
  @visibleForTesting
  final List<({String event, dynamic data})> sentEvents = [];

  /// Pushes an inbound event into [events] as if the server had sent it.
  @visibleForTesting
  void injectEvent(Map<String, dynamic> event) => _controller.add(event);

  bool get isConnected => _forcedConnected ?? (_socket?.connected == true);

  /// Remember which ride room this client belongs in, and join it now.
  ///
  /// Remembering is the important half: [_initSocket] re-joins [_activeRideId]
  /// on every reconnect, and until this method had a caller that field was
  /// always null — so the auto-rejoin was guarding a value nothing ever set.
  ///
  /// Routed through [emit] rather than touching `_socket` directly so the
  /// offline test double records it like any other outbound event.
  void updateActiveRide(String? rideId) {
    _activeRideId = rideId;
    if (rideId != null && isConnected) {
      emit('join', {'userId': rideId, 'role': 'ride'});
    }
  }

  void _initSocket() {
    final serverUrl = EnvConfig.current.apiBaseUrl.replaceAll('/api/v1', ''); // Strip API path for socket root
    
    _socket = IO.io(serverUrl, IO.OptionBuilder()
      .setTransports(['websocket'])
      .enableAutoConnect()
      .setReconnectionDelay(5000)
      .setAuth({'token': _token})
      .build());

    _socket!.onConnect((_) {
      print('Socket connected: $_role - $_userId');
      _socket!.emit('join', {'userId': _userId, 'role': _role});
      
      // Critical Hardening: Auto-rejoin active ride room on reconnect
      if (_activeRideId != null) {
        print('Socket re-joining active ride room: $_activeRideId');
        _socket!.emit('join', {'userId': _activeRideId, 'role': 'ride'});
      }

      // Notify listeners of reconnection for redundant state healing
      _controller.add({'event': 'socket:reconnected'});
    });

    _socket!.onDisconnect((_) {
      print('Socket disconnected');
      _controller.add({'event': 'socket:disconnected'});
    });

    _socket!.onConnectError((_) {
      print('Socket connect error');
      _controller.add({'event': 'socket:connect_error'});
    });

    _socket!.on('error', (_) {
      print('Socket error');
      _controller.add({'event': 'socket:connect_error'});
    });

    // Broad listener for all dispatcher events
    _socket!.onAny((event, data) {
      print('[SOCKET_RECEIVED] Event: $event | RawData: $data');
      if (data is Map) {
        final Map<String, dynamic> cleanData = data.map((key, value) => MapEntry(key.toString(), value));
        _controller.add({'event': event, ...cleanData});
      } else {
        _controller.add({'event': event, 'data': data});
      }
    });
  }

  /// Force a reconnect when the link looks dead.
  ///
  /// Socket.IO reconnects on its own, but a socket that has been suspended by
  /// the OS can sit in a stuck "connecting" state indefinitely. Disconnecting
  /// first clears that. Mirrors the driver app, which has had this since the
  /// resume-handling work.
  void reconnect() {
    final s = _socket;
    if (s == null) return;
    if (s.connected) return;
    print('[SOCKET] Forcing reconnect.');
    s.disconnect();
    s.connect();
  }

  /// Re-assert room membership on the CURRENT connection.
  ///
  /// Rooms are per-connection: a reconnect drops every one of them. The
  /// onConnect handler re-joins automatically, but an explicit call is needed
  /// when the client discovers it has gone stale without the socket ever having
  /// reported a disconnect — which is exactly what a suspended phone produces.
  void rejoinRooms() {
    if (!isConnected) return;
    emit('join', {'userId': _userId, 'role': _role});
    final rideId = _activeRideId;
    if (rideId != null) emit('join', {'userId': rideId, 'role': 'ride'});
  }

  /// The ride room this client believes it is in.
  ///
  /// Read by the field-test diagnostics overlay. Null while a ride is live is
  /// the single most diagnostic value available — it is exactly the state that
  /// produced the frozen-marker reports.
  String? get activeRideRoom => _activeRideId;

  void emit(String event, dynamic data) {
    if (_forcedConnected != null) {
      sentEvents.add((event: event, data: data));
      return;
    }
    _socket?.emit(event, data);
  }

  void dispose() {
    _socket?.dispose();
    _controller.close();
  }
}

// We will provide this per-app using specialized providers
