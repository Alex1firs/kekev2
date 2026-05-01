import 'dart:async';
import 'dart:io';
import 'package:dio/dio.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';

class NotificationService {
  final Dio? _dio;
  final String _role;
  final _intentStreamController = StreamController<Map<String, dynamic>>.broadcast();

  NotificationService(this._dio, this._role);

  Stream<Map<String, dynamic>> get intentStream => _intentStreamController.stream;

  Future<void> initialize() async {
    try {
      await Firebase.initializeApp();

      final messaging = FirebaseMessaging.instance;

      final settings = await messaging.requestPermission(
        alert: true,
        badge: true,
        sound: true,
      );

      if (settings.authorizationStatus == AuthorizationStatus.authorized) {
        print('[PUSH] Notification Permission Granted');
      }

      FirebaseMessaging.onMessage.listen((RemoteMessage message) {
        print('[PUSH] Foreground Message: ${message.data}');
      });

      FirebaseMessaging.onMessageOpenedApp.listen((RemoteMessage message) {
        print('[PUSH] Background Notification Tapped: ${message.data}');
        _intentStreamController.add(message.data);
      });

      FirebaseMessaging.instance.onTokenRefresh.listen((newToken) {
        print('[PUSH] Token refreshed: $newToken. Re-registering...');
        registerDeviceToken();
      });

    } catch (e) {
      print('[PUSH_ERROR] Initialization failed: $e');
    }
  }

  Future<void> handleInitialMessage() async {
    final initialMessage = await FirebaseMessaging.instance.getInitialMessage();
    if (initialMessage != null) {
      print('[PUSH] Terminated Launch via Notification: ${initialMessage.data}');
      _intentStreamController.add(initialMessage.data);
    }
  }

  Future<String?> getToken() async {
    try {
      return await FirebaseMessaging.instance.getToken();
    } catch (e) {
      print('[PUSH_ERROR] Failed to get token: $e');
      return null;
    }
  }

  Future<void> registerDeviceToken() async {
    if (_dio == null) return;

    final token = await getToken();
    if (token == null) return;

    try {
      print('[PUSH] Registering token with backend...');
      await _dio!.post('/notifications/tokens', data: {
        'token': token,
        'platform': Platform.isIOS ? 'ios' : 'android',
        'role': _role,
        'deviceLabel': Platform.localHostname,
      });
      print('[PUSH] Token successfully registered.');
    } catch (e) {
      print('[PUSH_ERROR] Failed to register token: $e');
    }
  }

  Future<void> deleteToken(String token) async {
    if (_dio == null) return;
    try {
      await _dio!.delete('/notifications/tokens/$token');
      print('[PUSH] Token deactivated on logout.');
    } catch (e) {
      print('[PUSH_ERROR] Failed to deactivate token: $e');
    }
  }
}
