import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../config/env_config.dart';
import '../storage/secure_storage.dart';
import 'notification_service.dart';
import 'retry_interceptor.dart';

class ApiClient {
  final Dio _dio;
  Dio get dio => _dio;

  ApiClient(this._dio);
}

/// Holds an optional logout callback that can be set by auth layers to avoid
/// circular imports between api_client and auth_controller.
final unauthorizedCallbackProvider = StateProvider<void Function()?>((_) => null);

final dioProvider = Provider<Dio>((ref) {
  final env = EnvConfig.current;

  final dio = Dio(
    BaseOptions(
      baseUrl: env.apiBaseUrl,
      // Generous by desktop standards, deliberately: a TLS handshake on a
      // congested Nigerian 3G cell regularly exceeds 15s, and a hard failure
      // costs a driver the trip. RetryInterceptor covers the rest.
      connectTimeout: const Duration(seconds: 20),
      receiveTimeout: const Duration(seconds: 30),
      sendTimeout: const Duration(seconds: 30),
    ),
  );

  dio.interceptors.add(RetryInterceptor(dio));

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
        if (e.response?.statusCode == 401 && !e.requestOptions.path.contains('/auth/')) {
          // Trigger logout callback — AuthController.logout() handles FCM
          // token deregistration before clearing storage.
          final callback = ref.read(unauthorizedCallbackProvider);
          if (callback != null) {
            Future.microtask(callback);
          }
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

final notificationServiceProvider = Provider.family<NotificationService, String>((ref, role) {
  final dio = ref.watch(dioProvider);
  return NotificationService(dio, role);
});
