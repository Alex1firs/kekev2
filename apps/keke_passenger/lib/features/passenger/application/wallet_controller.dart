import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:dio/dio.dart';
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
      final data = response.data;
      
      final history = (data['history'] as List)
          .map((json) => WalletTransaction.fromJson(json))
          .toList();

      state = state.copyWith(
        balance: double.parse(data['balance']['passengerBalance'].toString()),
        history: history,
        isLoading: false,
      );
    } catch (e) {
      state = state.copyWith(isLoading: false, errorMessage: 'Failed to load wallet');
    }
  }

  Future<String?> initializeTopup(double amount, String email) async {
    try {
      final response = await _api.dio.post('/finance/topup/init', data: {
        'userId': _userId,
        'amount': amount,
        'email': email,
      });
      return response.data['authorization_url'];
    } catch (e) {
      state = state.copyWith(errorMessage: 'Top-up initialization failed');
      return null;
    }
  }
}

final walletControllerProvider = StateNotifierProvider<WalletController, WalletState>((ref) {
  final authState = ref.watch(authControllerProvider);
  final apiClient = ref.watch(apiClientProvider);
  
  if (authState.status != AuthStatus.authenticated) {
    return WalletController(apiClient, 'guest'); 
  }
  
  return WalletController(apiClient, 'demo-passenger-id'); // Use a placeholder ID for now
});
