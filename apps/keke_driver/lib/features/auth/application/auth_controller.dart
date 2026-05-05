import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:jwt_decoder/jwt_decoder.dart';
import '../../../core/storage/secure_storage.dart';
import '../../../core/network/api_client.dart';
import '../../../core/network/notification_service.dart';
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
        if (JwtDecoder.isExpired(token)) {
          await _secureStorage.deleteToken();
          state = state.copyWith(status: AuthStatus.unauthenticated);
          return;
        }
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

  Future<void> login(String email, String password) async {
    if (state.status == AuthStatus.authenticating) return;

    state = AuthState.authenticating();
    try {
      final result = await _authRepository.login(email, password);
      final token = result['token'] as String;
      state = AuthState.transitioning(token);
      await _secureStorage.writeToken(token);
      state = AuthState.authenticated(token);
      _notificationService.registerDeviceToken();
    } on EmailNotVerifiedException catch (e) {
      state = AuthState.needsEmailVerification(e.email, devOtp: e.devOtp);
    } catch (e) {
      state = AuthState.error(e.toString());
      await Future.delayed(const Duration(milliseconds: 100));
      state = AuthState.unauthenticated();
    }
  }

  Future<void> signup(
      String email, String password, String firstName, String lastName, String phone) async {
    if (state.status == AuthStatus.authenticating) return;

    state = AuthState.authenticating();
    try {
      final result = await _authRepository.signup(email, password, firstName, lastName, phone);
      final devOtp = result['otp'] as String?;
      state = AuthState.needsEmailVerification(email, devOtp: devOtp);
    } catch (e) {
      state = AuthState.error(e.toString());
      await Future.delayed(const Duration(milliseconds: 100));
      state = AuthState.unauthenticated();
    }
  }

  Future<void> verifyEmail(String email, String otp) async {
    if (state.status == AuthStatus.authenticating) return;
    state = state.copyWith(status: AuthStatus.authenticating);
    try {
      final token = await _authRepository.confirmEmailVerification(email, otp);
      state = AuthState.transitioning(token);
      await _secureStorage.writeToken(token);
      state = AuthState.authenticated(token);
      _notificationService.registerDeviceToken();
    } catch (e) {
      state = state.copyWith(
        status: AuthStatus.needsEmailVerification,
        errorMessage: e.toString().replaceFirst('Exception: ', ''),
      );
    }
  }

  Future<String?> resendVerificationOtp(String email) async {
    try {
      final result = await _authRepository.requestEmailVerification(email);
      final devOtp = result['otp'] as String?;
      state = AuthState.needsEmailVerification(email, devOtp: devOtp);
      return null;
    } catch (e) {
      return e.toString().replaceFirst('Exception: ', '');
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
  final controller = AuthController(
    ref.watch(authRepositoryProvider),
    ref.watch(secureStorageServiceProvider),
    ref.watch(notificationServiceProvider('driver')),
  );

  // Wire up the 401 callback so api_client can trigger logout without a circular import
  ref.read(unauthorizedCallbackProvider.notifier).state = controller.logout;

  return controller;
});
