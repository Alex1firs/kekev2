import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../config/env_config.dart';
import '../storage/secure_storage.dart';

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
          // Clear storage and trigger auth state change via callback
          await ref.read(secureStorageServiceProvider).clearAll();
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
