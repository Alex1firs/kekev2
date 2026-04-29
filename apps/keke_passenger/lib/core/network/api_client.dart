import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../config/env_config.dart';
import '../storage/secure_storage.dart';

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
          // Clear storage and signal auth expiry; auth_controller listens to this flag
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
