import 'package:dio/dio.dart';

/// Retries requests that a second attempt has a real chance of completing.
///
/// Nigerian mobile data routinely drops a TCP/TLS handshake that succeeds on the
/// next try, so a single failed tap should not surface as an error. This also
/// covers the few-second window during a backend redeploy when nginx has no
/// upstream and returns 502.
///
/// Safety rule: a failure that happened *before* the connection was established
/// means the server saw nothing, so replaying is safe for any method. Once the
/// request is on the wire we cannot know whether the server applied it, so only
/// reads are replayed — never a POST that might create a ride or move money.
class RetryInterceptor extends Interceptor {
  RetryInterceptor(this._dio);

  final Dio _dio;

  static const _delays = [
    Duration(milliseconds: 700),
    Duration(seconds: 2),
  ];

  static const _attemptKey = 'retry_attempt';

  @override
  void onError(DioException err, ErrorInterceptorHandler handler) async {
    final attempt = (err.requestOptions.extra[_attemptKey] as int?) ?? 0;
    if (attempt >= _delays.length || !_shouldRetry(err)) {
      return handler.next(err);
    }

    await Future<void>.delayed(_delays[attempt]);

    final options = err.requestOptions
      ..extra = {...err.requestOptions.extra, _attemptKey: attempt + 1};
    try {
      return handler.resolve(await _dio.fetch(options));
    } on DioException catch (e) {
      return handler.next(e);
    }
  }

  bool _shouldRetry(DioException e) {
    // Never reached the server — safe to replay whatever the method was.
    if (e.type == DioExceptionType.connectionTimeout ||
        e.type == DioExceptionType.connectionError) {
      return true;
    }

    // Past this point the server may already have applied the request.
    if (e.requestOptions.method.toUpperCase() != 'GET') return false;

    if (e.type == DioExceptionType.receiveTimeout) return true;

    final status = e.response?.statusCode ?? 0;
    return status == 502 || status == 503 || status == 504;
  }
}
