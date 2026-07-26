import 'dart:async';
import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:socket_io_client/socket_io_client.dart' as IO;
import 'package:flutter_riverpod/flutter_riverpod.dart';
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
  /// recorded in [sentEvents] instead of hitting the network. Mirrors the
  /// passenger app's seam so both sides of one coordination flow are tested the
  /// same way.
  @visibleForTesting
  SocketService.offline({bool connected = true})
      : _role = 'driver',
        _userId = 'test-driver',
        _token = '',
        _forcedConnected = connected;

  bool? _forcedConnected;

  /// Outbound emits captured by [SocketService.offline]. Always empty in prod.
  @visibleForTesting
  final List<({String event, dynamic data})> sentEvents = [];

  /// Pushes an inbound event into [events] as if the server had sent it.
  @visibleForTesting
  void injectEvent(Map<String, dynamic> event) => _controller.add(event);

  void updateActiveRide(String? rideId) {
    _activeRideId = rideId;
    if (rideId != null && _socket?.connected == true) {
      _socket!.emit('join', {'userId': rideId, 'role': 'ride'});
    }
  }

  void _initSocket() {
    final serverUrl = EnvConfig.current.apiBaseUrl.replaceAll('/api/v1', ''); // Strip API path for socket root
    
    _socket = IO.io(serverUrl, IO.OptionBuilder()
      // Allow polling as fallback — on Android, raw WebSocket can fail
      // silently; polling ensures the connection still works.
      .setTransports(['websocket', 'polling'])
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

    _socket!.onConnectError((err) {
      print('Socket connect error: $err');
      _controller.add({'event': 'socket:connect_error', 'message': err?.toString() ?? 'Connection failed'});
    });

    _socket!.onDisconnect((_) {
      print('Socket disconnected');
      // Surface disconnects so the controller can drive an honest UI
      // ("Reconnecting…") instead of silently claiming the driver is Online.
      _controller.add({'event': 'socket:disconnected'});
    });

    // Broad listener for all dispatcher events
    _socket!.onAny((event, data) {
      if (data is Map) {
        final Map<String, dynamic> cleanData = data.map((key, value) => MapEntry(key.toString(), value));
        _controller.add({'event': event, ...cleanData});
      } else {
        _controller.add({'event': event, 'data': data});
      }
    });
  }

  bool get isConnected => _forcedConnected ?? (_socket?.connected ?? false);

  /// Force a fresh reconnect. Call when the app returns to the foreground:
  /// iOS/Android suspend the socket while backgrounded, and the built-in
  /// auto-reconnect can lag or get stuck on "Connecting…". Dialing a clean
  /// connection here makes the driver rejoin (and the server re-deliver any
  /// ride offer they missed) within ~1s instead of waiting on the retry timer.
  void reconnect() {
    final s = _socket;
    if (s == null) return;
    if (s.connected) return;
    print('[SOCKET] Forcing reconnect on resume...');
    s.disconnect(); // clear any stuck "connecting" state
    s.connect();
  }

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
