import '../../auth/application/auth_controller.dart';
import '../../auth/domain/auth_state.dart';
import '../domain/driver_finance_state.dart';
import '../../../core/network/api_client.dart';
import 'package:jwt_decoder/jwt_decoder.dart';

// ... existing code ...

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
