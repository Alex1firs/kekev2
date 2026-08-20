import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:dio/dio.dart' as dio;
import '../../auth/application/auth_controller.dart';
import '../../auth/domain/auth_state.dart';
import '../domain/driver_finance_state.dart';
import '../../../core/network/api_client.dart';
import '../../../core/network/socket_service.dart';
import '../../../core/network/socket_provider.dart';
import 'package:jwt_decoder/jwt_decoder.dart';

class DriverFinanceController extends StateNotifier<DriverFinanceState>
    with WidgetsBindingObserver {
  final ApiClient _apiClient;
  final String _userId;

  StreamSubscription<Map<String, dynamic>>? _walletSub;

  DriverFinanceController(this._apiClient, this._userId, {SocketService? socket})
      : super(DriverFinanceState(isLoading: true)) {
    if (_userId != 'guest' && _userId != 'error') {
      _loadData();
      _listenForWalletChanges(socket);
      WidgetsBinding.instance.addObserver(this);
    } else {
      state = DriverFinanceState();
    }
  }

  /// Apply wallet changes the moment the server publishes them.
  ///
  /// Before this the screen only ever learned about a commission charge or a
  /// top-up by being opened — so a driver watching it while a ride completed,
  /// or while an operator funded them at the park, saw a stale number with no
  /// way to know it was stale.
  ///
  /// The event carries the authoritative figures rather than a nudge to
  /// refetch, so there is no window in which the screen is still wrong. A
  /// missed event self-corrects on the next refresh: the endpoint stays the
  /// source of truth and this is an accelerator, not a second one.
  void _listenForWalletChanges(SocketService? socket) {
    if (socket == null) return;
    _walletSub = socket.events.listen((event) {
      if (event['event'] != 'wallet:updated') return;
      final data = event['data'] as Map<String, dynamic>? ?? event;
      if (!mounted) return;
      state = state.copyWith(
        availableBalance: (data['availableBalance'] as num?)?.toDouble() ?? state.availableBalance,
        commissionDebt: (data['outstandingDebt'] as num?)?.toDouble() ?? state.commissionDebt,
        pendingBalance: (data['pendingBalance'] as num?)?.toDouble() ?? state.pendingBalance,
        withdrawable: (data['withdrawable'] as num?)?.toDouble() ?? state.withdrawable,
        isLoading: false,
      );
      // The balances are already correct on screen. Refresh the history in the
      // background so the transaction list catches up too, without blocking.
      _loadData();
    });
  }

  /// Refetch on resume, rather than trusting that an event arrived.
  ///
  /// Android drops the socket while backgrounded, so a commission charged or a
  /// top-up applied during that time produces a `wallet:updated` nobody is
  /// listening for. Coming back to a screen showing money that is no longer
  /// correct is the failure this exists to prevent.
  ///
  /// The event is an accelerator; the endpoint is the source of truth. This is
  /// what makes a missed event self-correcting rather than permanent.
  @override
  void didChangeAppLifecycleState(AppLifecycleState lifecycleState) {
    if (lifecycleState == AppLifecycleState.resumed && mounted) {
      _loadData();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _walletSub?.cancel();
    super.dispose();
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
        withdrawable: double.tryParse(data['withdrawable']?.toString() ?? '0') ?? 0,
        pendingBalance: double.tryParse(balance['driverPendingBalance']?.toString() ?? '0') ?? 0,
        commissionDebt: double.tryParse(balance['driverCommissionDebt']?.toString() ?? '0') ?? 0,
        totalCommissionPaid: double.tryParse(data['totalCommissionPaid']?.toString() ?? '0') ?? 0.0,
        totalTrips: int.tryParse(data['totalTrips']?.toString() ?? '0') ?? 0,
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
  // Read, not watch: a socket reconnect must not tear down and rebuild the
  // finance controller, which would drop the balances off screen mid-shift.
  final socket = ref.read(socketServiceProvider);

  if (authState.status != AuthStatus.authenticated || authState.token == null) {
    return DriverFinanceController(apiClient, 'guest');
  }

  try {
    final decoded = JwtDecoder.decode(authState.token!);
    final userId = decoded['userId']?.toString();
    if (userId == null) throw 'Missing userId';
    return DriverFinanceController(apiClient, userId, socket: socket);
  } catch (e) {
    return DriverFinanceController(apiClient, 'error');
  }
});
