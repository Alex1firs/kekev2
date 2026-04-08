import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/storage/secure_storage.dart';
import '../data/auth_repository.dart';
import '../domain/auth_state.dart';

class AuthController extends StateNotifier<AuthState> {
  final AuthRepository _authRepository;
  final SecureStorageService _secureStorage;

  AuthController(this._authRepository, this._secureStorage) 
      : super(AuthState.initializing()) {
    _restoreSession();
  }

  Future<void> _restoreSession() async {
    try {
      final token = await _secureStorage.readToken();
      if (token != null && token.isNotEmpty) {
        // Token exists. In Phase 2 MVP, we assume possession equals authentication
        // until a 401 is encountered on a subsequent API call.
        state = AuthState.authenticated(token);
      } else {
        state = AuthState.unauthenticated();
      }
    } catch (_) {
      // Crash-safe session restore
      await _secureStorage.clearAll();
      state = AuthState.unauthenticated();
    }
  }

  Future<void> login(String phone, String password) async {
    if (state.status == AuthStatus.authenticating) return; // Prevent duplicates

    state = AuthState.authenticating();
    try {
      final token = await _authRepository.login(phone, password);
      // Strictly Transitioning state guarantees storage writes finish before routing
      state = AuthState.transitioning(token);
      await _secureStorage.writeToken(token);
      state = AuthState.authenticated(token);
    } catch (e) {
      state = AuthState.error(e.toString());
      // Revert back to unauthenticated after emitting error
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
    } catch (e) {
      state = AuthState.error(e.toString());
      await Future.delayed(const Duration(milliseconds: 100));
      state = AuthState.unauthenticated();
    }
  }

  Future<void> logout() async {
    // Explicit transition away guarantees UI drops to unauthenticated smoothly.
    state = AuthState.initializing();
    await _secureStorage.clearAll();
    state = AuthState.unauthenticated();
  }

  /// System-triggered cleanup when APIs return 401 Unauthorized
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
  );
});
