import 'dart:async';
import 'package:socket_io_client/socket_io_client.dart' as IO;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../config/env_config.dart';

class SocketService {
  IO.Socket? _socket;
  final String _role;
  final String _userId;
  
  final _controller = StreamController<Map<String, dynamic>>.broadcast();
  Stream<Map<String, dynamic>> get events => _controller.stream;

  SocketService(this._role, this._userId) {
    _initSocket();
  }

  void _initSocket() {
    final serverUrl = EnvConfig.current.apiUrl.replaceAll('/api/v1', ''); // Strip API path for socket root
    
    _socket = IO.io(serverUrl, IO.OptionBuilder()
      .setTransports(['websocket'])
      .enableAutoConnect()
      .setReconnectionDelay(5000)
      .build());

    _socket!.onConnect((_) {
      print('Socket connected: $_role - $_userId');
      _socket!.emit('join', {'userId': _userId, 'role': _role});
    });

    _socket!.onDisconnect((_) => print('Socket disconnected'));

    // Broad listener for all dispatcher events
    _socket!.onAny((event, data) {
      if (data is Map<String, dynamic>) {
        _controller.add({'event': event, ...data});
      } else {
        _controller.add({'event': event, 'data': data});
      }
    });
  }

  void emit(String event, dynamic data) {
    _socket?.emit(event, data);
  }

  void dispose() {
    _socket?.dispose();
    _controller.close();
  }
}

// We will provide this per-app using specialized providers
