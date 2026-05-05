import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/network/api_client.dart';

class AuthRepository {
  final ApiClient _apiClient;

  AuthRepository(this._apiClient);

  Future<Map<String, dynamic>> login(String email, String password) async {
    try {
      final response = await _apiClient.dio.post('/auth/login', data: {
        'email': email,
        'password': password,
      });
      return Map<String, dynamic>.from(response.data);
    } on DioException catch (e) {
      if (e.response?.statusCode == 401) {
        throw Exception('Invalid email or password');
      }
      if (e.response?.statusCode == 403) {
        final data = e.response?.data ?? {};
        throw EmailNotVerifiedException(
          email: data['email'] ?? email,
          devOtp: data['otp'] as String?,
        );
      }
      throw Exception(e.response?.data?['error']?.toString() ?? e.message ?? 'Login failed');
    }
  }

  Future<Map<String, dynamic>> signup(
      String email, String password, String firstName, String lastName, String phone) async {
    try {
      final response = await _apiClient.dio.post('/auth/signup', data: {
        'email': email,
        'password': password,
        'first_name': firstName,
        'last_name': lastName,
        'phone': phone,
      });
      return Map<String, dynamic>.from(response.data);
    } on DioException catch (e) {
      if (e.response?.statusCode == 409) {
        throw Exception('Email address already registered');
      }
      throw Exception(e.response?.data?['error']?.toString() ?? e.message ?? 'Signup failed');
    }
  }

  Future<Map<String, dynamic>> requestEmailVerification(String email) async {
    try {
      final response = await _apiClient.dio.post('/auth/email-verification/request', data: {'email': email});
      return Map<String, dynamic>.from(response.data);
    } on DioException catch (e) {
      if (e.response?.statusCode == 429) {
        throw Exception(e.response?.data?['error']?.toString() ?? 'Please wait before requesting another code.');
      }
      throw Exception(e.response?.data?['error']?.toString() ?? 'Request failed');
    }
  }

  Future<String> confirmEmailVerification(String email, String otp) async {
    try {
      final response = await _apiClient.dio.post('/auth/email-verification/confirm', data: {
        'email': email,
        'otp': otp,
      });
      return response.data['token'] as String;
    } on DioException catch (e) {
      if (e.response?.statusCode == 429) {
        throw Exception('Too many failed attempts. Request a new code.');
      }
      throw Exception(e.response?.data?['error']?.toString() ?? 'Verification failed');
    }
  }

  Future<Map<String, dynamic>> requestPasswordReset(String email) async {
    try {
      final response = await _apiClient.dio.post('/auth/reset-password/request', data: {'email': email});
      return Map<String, dynamic>.from(response.data);
    } on DioException catch (e) {
      if (e.response?.statusCode == 429) {
        throw Exception(e.response?.data?['error']?.toString() ?? 'Please wait before requesting another code.');
      }
      throw Exception(e.response?.data?['error']?.toString() ?? 'Request failed');
    }
  }

  Future<String> confirmPasswordReset(String email, String otp, String newPassword) async {
    try {
      final response = await _apiClient.dio.post('/auth/reset-password/confirm', data: {
        'email': email,
        'otp': otp,
        'newPassword': newPassword,
      });
      return response.data['token'] as String;
    } on DioException catch (e) {
      throw Exception(e.response?.data?['error']?.toString() ?? 'Reset failed');
    }
  }
}

class EmailNotVerifiedException implements Exception {
  final String email;
  final String? devOtp;
  const EmailNotVerifiedException({required this.email, this.devOtp});
}

final authRepositoryProvider = Provider<AuthRepository>((ref) {
  return AuthRepository(ref.watch(apiClientProvider));
});
