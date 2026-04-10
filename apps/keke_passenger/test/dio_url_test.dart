import 'package:flutter_test/flutter_test.dart';
import 'package:dio/dio.dart';

void main() {
  test('Dio URL resolution', () async {
    final dio = Dio(BaseOptions(baseUrl: 'https://api.kekeride.ng/api/v1'));
    dio.interceptors.add(InterceptorsWrapper(
      onRequest: (options, handler) {
        print('ACTUAL URI: \${options.uri}');
        return handler.reject(DioException(requestOptions: options, message: 'Stop here'));
      }
    ));
    try {
      await dio.post('/api/v1/auth/login', data: {'foo': 'bar'});
    } catch (e) {
      // Ignore
    }
  });
}
