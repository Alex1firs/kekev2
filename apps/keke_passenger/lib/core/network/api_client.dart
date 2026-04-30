import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../config/env_config.dart';
import '../storage/secure_storage.dart';
import 'notification_service.dart';

class ApiClient {
  final Dio _dio;
  Dio get dio => _dio;

  ApiClient(this._dio);
}

final dioProvider = Provider<Dio>((ref) {
  final env = EnvConfig.current;
  
  final dio = Dio(
    BaseOptions(
      baseUrl: env.apiBaseUrl,
      connectTimeout: const Duration(seconds: 15),
      receiveTimeout: const Duration(seconds: 15),
    ),
  );
  
  dio.interceptors.add(
    InterceptorsWrapper(
      onRequest: (options, handler) async {
        // Read token dynamically on every request
        final token = await ref.read(secureStorageServiceProvider).readToken();
        if (token != null) {
          options.headers['Authorization'] = 'Bearer $token';
        }
        return handler.next(options);
      },
      onError: (DioException e, handler) async {
        if (e.response?.statusCode == 401) {
          // Deregister FCM device token before clearing auth so the old token
          // is marked inactive and won't deliver notifications to the next user.
          try {
            final notifService = ref.read(notificationServiceProvider('passenger'));
            final fcmToken = await notifService.getToken();
            if (fcmToken != null) await notifService.deleteToken(fcmToken);
          } catch (_) {}
          await ref.read(secureStorageServiceProvider).clearAll();
          ref.read(unauthorizedEventProvider.notifier).state = true;
        }
        return handler.next(e);
      },
    ),
  );

  return dio;
});

final apiClientProvider = Provider<ApiClient>((ref) {
  return ApiClient(ref.watch(dioProvider));
});

/// Fires true when the server returns 401, signalling that the session is invalid.
/// AuthController watches this to set state to unauthenticated without a circular import.
final unauthorizedEventProvider = StateProvider<bool>((ref) => false);
