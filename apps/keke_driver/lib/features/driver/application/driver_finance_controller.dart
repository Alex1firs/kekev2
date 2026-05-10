import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:dio/dio.dart' as dio;
import '../../auth/application/auth_controller.dart';
import '../../auth/domain/auth_state.dart';
import '../domain/driver_finance_state.dart';
import '../../../core/network/api_client.dart';
import 'package:jwt_decoder/jwt_decoder.dart';

class DriverFinanceController extends StateNotifier<DriverFinanceState> {
  final ApiClient _apiClient;
  final String _userId;

  DriverFinanceController(this._apiClient, this._userId) : super(DriverFinanceState(isLoading: true)) {
    if (_userId != 'guest' && _userId != 'error') {
      _loadData();
    } else {
      state = DriverFinanceState();
    }
  }

  Future<void> _loadData() async {
    if (!mounted) return;
    state = state.copyWith(isLoading: true, errorMessage: null);
    try {
      final response = await _apiClient.dio.get('/finance/balance/$_userId');
      final data = response.data as Map<String, dynamic>;
      final balance = data['balance'] as Map<String, dynamic>? ?? {};
      final historyRaw = data['history'] as List<dynamic>? ?? [];

      final history = historyRaw
          .map((e) => DriverHistoryEntry.fromJson(e as Map<String, dynamic>))
          .toList();

      if (!mounted) return;
      state = state.copyWith(
        availableBalance: double.tryParse(balance['driverAvailableBalance']?.toString() ?? '0') ?? 0,
        pendingBalance: double.tryParse(balance['driverPendingBalance']?.toString() ?? '0') ?? 0,
        commissionDebt: double.tryParse(balance['driverCommissionDebt']?.toString() ?? '0') ?? 0,
        history: history,
        isLoading: false,
      );
    } on dio.DioException catch (e) {
      if (!mounted) return;
      state = state.copyWith(
        isLoading: false,
        errorMessage: e.response?.data?['message']?.toString() ?? 'Couldn\'t load your earnings. Please try again.',
      );
    } catch (e) {
      if (!mounted) return;
      state = state.copyWith(isLoading: false, errorMessage: 'Couldn\'t load your earnings. Please try again.');
    }
  }

  Future<void> refresh() => _loadData();

  /// Submit a payout request. Debits driverAvailableBalance and creates a PayoutRecord.
  Future<bool> initiatePayout(double amount, String bankCode, String accountNumber) async {
    try {
      await _apiClient.dio.post('/finance/payout/init', data: {
        'amount': amount,
        'bankCode': bankCode,
        'accountNumber': accountNumber,
      });
      await _loadData();
      return true;
    } on dio.DioException catch (e) {
      if (mounted) {
        state = state.copyWith(errorMessage: e.response?.data?['message']?.toString() ?? 'Payout request failed. Please try again.');
      }
      return false;
    } catch (_) {
      if (mounted) state = state.copyWith(errorMessage: 'Payout request failed. Please try again.');
      return false;
    }
  }

  /// Initialize a Paystack top-up for the driver wallet.
  /// Returns {authorization_url, reference} on success, null on failure.
  Future<Map<String, String>?> topupWallet(double amount, String email) async {
    try {
      final response = await _apiClient.dio.post('/finance/topup/driver/init', data: {
        'email': email,
        'amount': amount,
      });
      final url = response.data['authorization_url'] as String?;
      final ref = response.data['reference'] as String?;
      if (url == null || ref == null) return null;
      return {'url': url, 'reference': ref};
    } on dio.DioException catch (e) {
      if (mounted) {
        state = state.copyWith(errorMessage: e.response?.data?['message']?.toString() ?? 'Top-up failed. Please try again.');
      }
      return null;
    } catch (_) {
      if (mounted) state = state.copyWith(errorMessage: 'Top-up failed. Please try again.');
      return null;
    }
  }

  /// Verify a completed Paystack payment and credit the wallet.
  Future<bool> verifyTopup(String reference) async {
    try {
      final response = await _apiClient.dio.post('/finance/topup/verify', data: {'reference': reference});
      final verified = response.data['verified'] as bool? ?? false;
      if (verified) await _loadData();
      return verified;
    } catch (_) {
      await _loadData();
      return false;
    }
  }

  /// Apply existing driverAvailableBalance directly against commission debt.
  /// Returns amount applied. Refreshes state afterward.
  Future<double> repayDebt() async {
    try {
      final response = await _apiClient.dio.post('/finance/debt/repay');
      final applied = (response.data['applied'] as num?)?.toDouble() ?? 0.0;
      await _loadData();
      return applied;
    } on dio.DioException catch (e) {
      if (mounted) {
        state = state.copyWith(errorMessage: e.response?.data?['message']?.toString() ?? 'Repayment failed. Please try again.');
      }
      return 0;
    } catch (_) {
      if (mounted) state = state.copyWith(errorMessage: 'Repayment failed. Please try again.');
      return 0;
    }
  }
}

final driverFinanceControllerProvider = StateNotifierProvider<DriverFinanceController, DriverFinanceState>((ref) {
  final authState = ref.watch(authControllerProvider);
  final apiClient = ref.watch(apiClientProvider);

  if (authState.status != AuthStatus.authenticated || authState.token == null) {
    return DriverFinanceController(apiClient, 'guest');
  }

  try {
    final decoded = JwtDecoder.decode(authState.token!);
    final userId = decoded['userId']?.toString();
    if (userId == null) throw 'Missing userId';
    return DriverFinanceController(apiClient, userId);
  } catch (e) {
    return DriverFinanceController(apiClient, 'error');
  }
});
