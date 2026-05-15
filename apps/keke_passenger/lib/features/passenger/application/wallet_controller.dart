import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:jwt_decoder/jwt_decoder.dart';
import '../../auth/application/auth_controller.dart';
import '../../auth/domain/auth_state.dart';
import '../domain/wallet_state.dart';
import '../../../core/network/api_client.dart';

class WalletController extends StateNotifier<WalletState> {
  final ApiClient _api;
  final String _userId;

  WalletController(this._api, this._userId) : super(WalletState()) {
    refresh();
  }

  Future<void> refresh() async {
    state = state.copyWith(isLoading: true, errorMessage: null);
    try {
      final response = await _api.dio.get('/finance/balance/$_userId');
      final data = response.data as Map<String, dynamic>;
      final balanceMap = data['balance'] as Map<String, dynamic>? ?? {};
      final historyRaw = data['history'] as List<dynamic>? ?? [];

      final balance = double.tryParse(balanceMap['passengerBalance']?.toString() ?? '') ?? 0.0;
      final history = historyRaw
          .map((json) => WalletTransaction.fromJson(json as Map<String, dynamic>))
          .toList();

      state = state.copyWith(balance: balance, history: history, isLoading: false);
    } catch (e) {
      state = state.copyWith(isLoading: false, errorMessage: 'Couldn\'t load your wallet. Please try again.');
    }
  }

  Future<Map<String, String>?> initializeTopup(double amount, String email) async {
    try {
      final response = await _api.dio.post('/finance/topup/init', data: {
        'userId': _userId,
        'amount': amount,
        'email': email,
      });
      final url = response.data['authorization_url'] as String?;
      final ref = response.data['reference'] as String?;
      if (url == null || ref == null) return null;
      return {'url': url, 'reference': ref};
    } on DioException catch (e) {
      state = state.copyWith(errorMessage: e.response?.data?['message']?.toString() ?? 'Couldn\'t start top-up. Please try again.');
      return null;
    } catch (e) {
      state = state.copyWith(errorMessage: 'Couldn\'t start top-up. Please try again.');
      return null;
    }
  }

  Future<bool> verifyTopup(String reference) async {
    try {
      final response = await _api.dio.post('/finance/topup/verify', data: {'reference': reference});
      final verified = response.data['verified'] as bool? ?? false;
      if (verified) await refresh();
      return verified;
    } catch (_) {
      await refresh();
      return false;
    }
  }
}

final walletControllerProvider = StateNotifierProvider<WalletController, WalletState>((ref) {
  final authState = ref.watch(authControllerProvider);
  final apiClient = ref.watch(apiClientProvider);
  
  if (authState.status != AuthStatus.authenticated || authState.token == null) {
    return WalletController(apiClient, 'guest'); 
  }
  
  try {
    final decoded = JwtDecoder.decode(authState.token!);
    final userId = decoded['userId']?.toString();
    if (userId == null) throw 'Missing userId';
    return WalletController(apiClient, userId);
  } catch (e) {
    print('[WALLET_ERROR] Identity extraction failed: $e');
    return WalletController(apiClient, 'error-id');
  }
});
