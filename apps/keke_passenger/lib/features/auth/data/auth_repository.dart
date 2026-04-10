import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/network/api_client.dart';

class AuthRepository {
  final ApiClient _apiClient;

  AuthRepository(this._apiClient);

  Future<String> login(String phone, String password) async {
    // Note: Using absolute path resolution from core api client
    // For Phase 2, we simulate deterministic backend auth.
    try {
      final response = await _apiClient.dio.post('/auth/login', data: {
        'phone': phone,
        'password': password,
      });
      // Expecting { "token": "jwt..." }
      return response.data['token'] as String;
    } on DioException catch (e) {
      if (e.response?.statusCode == 401) {
        throw Exception('Invalid phone or password');
      }
      throw Exception(e.message ?? 'Unknown login error');
    }
  }

  Future<String> signup(String phone, String password, String firstName, String lastName) async {
    try {
      final response = await _apiClient.dio.post('/auth/signup', data: {
        'phone': phone,
        'password': password,
        'first_name': firstName,
        'last_name': lastName,
      });
      return response.data['token'] as String;
    } on DioException catch (e) {
      if (e.response?.statusCode == 409) {
        throw Exception('Phone number already exists');
      }
      throw Exception(e.message ?? 'Unknown signup error');
    }
  }
}

final authRepositoryProvider = Provider<AuthRepository>((ref) {
  return AuthRepository(ref.watch(apiClientProvider));
});
