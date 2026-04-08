import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../auth/application/auth_controller.dart';
import '../domain/driver_finance_state.dart';
import '../../../core/network/api_client.dart';

class DriverFinanceController extends StateNotifier<DriverFinanceState> {
  final ApiClient _api;
  final String _userId;

  DriverFinanceController(this._api, this._userId) : super(DriverFinanceState()) {
    refresh();
  }

  Future<void> refresh() async {
    state = state.copyWith(isLoading: true, errorMessage: null);
    try {
      final response = await _api.dio.get('/finance/balance/$_userId');
      final data = response.data;
      
      final history = (data['history'] as List)
          .map((json) => DriverHistoryEntry.fromJson(json))
          .toList();

      state = state.copyWith(
        availableBalance: double.parse(data['balance']['driverAvailableBalance'].toString()),
        pendingBalance: double.parse(data['balance']['driverPendingBalance'].toString()),
        commissionDebt: double.parse(data['balance']['driverCommissionDebt'].toString()),
        history: history,
        isLoading: false,
      );
    } catch (e) {
      state = state.copyWith(isLoading: false, errorMessage: 'Failed to load earnings');
    }
  }

  // Threshold Checks
  bool get hasRestriction => state.commissionDebt >= 2000;
  bool get hasHardBlock => state.commissionDebt >= 5000;
}

final driverFinanceControllerProvider = StateNotifierProvider<DriverFinanceController, DriverFinanceState>((ref) {
  final authState = ref.watch(authControllerProvider);
  final apiClient = ref.watch(apiClientProvider);
  
  if (authState.user == null) {
    return DriverFinanceController(apiClient, 'guest');
  }
  
  return DriverFinanceController(apiClient, authState.user!.id);
});
