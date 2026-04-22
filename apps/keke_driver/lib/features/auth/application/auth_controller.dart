import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/storage/secure_storage.dart';
import '../../core/network/notification_service.dart';
import '../data/auth_repository.dart';
import '../domain/auth_state.dart';

class AuthController extends StateNotifier<AuthState> {
  final AuthRepository _authRepository;
  final SecureStorageService _secureStorage;
  final NotificationService _notificationService;

  AuthController(this._authRepository, this._secureStorage, this._notificationService) 
      : super(AuthState.initializing()) {
    _restoreSession();
  }

  Future<void> _restoreSession() async {
    try {
      final token = await _secureStorage.readToken();
      if (token != null && token.isNotEmpty) {
        state = AuthState.authenticated(token);
        _notificationService.registerDeviceToken();
      } else {
        state = AuthState.unauthenticated();
      }
    } catch (_) {
      await _secureStorage.clearAll();
      state = AuthState.unauthenticated();
    }
  }

  Future<void> login(String phone, String password) async {
    if (state.status == AuthStatus.authenticating) return;

    state = AuthState.authenticating();
    try {
      final token = await _authRepository.login(phone, password);
      state = AuthState.transitioning(token);
      await _secureStorage.writeToken(token);
      state = AuthState.authenticated(token);
      
      _notificationService.registerDeviceToken();
    } catch (e) {
      state = AuthState.error(e.toString());
      await Future.delayed(const Duration(milliseconds: 100));
      state = AuthState.unauthenticated();
    }
  }

  Future<void> signup(String phone, String password, String firstName, String lastName) async {
    if (state.status == AuthStatus.authenticating) return;

    state = AuthState.authenticating();
    try {
      final token = await _authRepository.signup(phone, password, firstName, lastName);
      state = AuthState.transitioning(token);
      await _secureStorage.writeToken(token);
      state = AuthState.authenticated(token);

      _notificationService.registerDeviceToken();
    } catch (e) {
      state = AuthState.error(e.toString());
      await Future.delayed(const Duration(milliseconds: 100));
      state = AuthState.unauthenticated();
    }
  }

  Future<void> logout() async {
    final token = await _notificationService.getToken();
    if (token != null) {
      await _notificationService.deleteToken(token);
    }

    state = AuthState.initializing();
    await _secureStorage.clearAll();
    state = AuthState.unauthenticated();
  }

  Future<void> forceUnauthorizedCleanup() async {
    if (state.status == AuthStatus.unauthenticated) return;
    await _secureStorage.clearAll();
    state = AuthState.unauthenticated();
  }
}

final authControllerProvider = StateNotifierProvider<AuthController, AuthState>((ref) {
  return AuthController(
    ref.watch(authRepositoryProvider),
    ref.watch(secureStorageServiceProvider),
    ref.watch(notificationServiceProvider('driver')),
  );
});
