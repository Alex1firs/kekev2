import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../config/env_config.dart';
import '../storage/secure_storage.dart';
// Will dynamically inject token and trigger force logout on 401s
import '../../features/auth/application/auth_controller.dart';

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
      onError: (DioException e, handler) {
        if (e.response?.statusCode == 401) {
          // Trigger unauthorized handling safely
          ref.read(authControllerProvider.notifier).forceUnauthorizedCleanup();
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
