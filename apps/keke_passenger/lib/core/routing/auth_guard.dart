import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../features/auth/application/auth_controller.dart';
import '../../features/auth/domain/auth_state.dart';

class AuthGuard extends ChangeNotifier {
  final Ref _ref;

  AuthGuard(this._ref) {
    // Notify GoRouter whenever auth state changes so redirects fire
    _ref.listen(authControllerProvider, (_, __) => notifyListeners());
  }

  String? redirectHook(BuildContext context, GoRouterState state) {
    // SCREENSHOT MODE: bypass all auth redirects
    const kScreenshotMode = bool.fromEnvironment('SCREENSHOT_MODE', defaultValue: false);
    if (kScreenshotMode) return null;

    final authState = _ref.read(authControllerProvider);
    final isSplash = state.matchedLocation == '/splash';
    final isAuthRoute = state.matchedLocation == '/login' ||
                        state.matchedLocation == '/signup' ||
                        state.matchedLocation == '/verify-email' ||
                        state.matchedLocation == '/forgot-password';

    if (authState.status == AuthStatus.initializing) {
      // Must stay on splash page while restoring session
      return isSplash ? null : '/splash';
    }

    if (authState.status == AuthStatus.authenticated) {
      if (isAuthRoute || isSplash) {
        return '/home'; // Authenticated users safely sent to home
      }
      return null;
    }

    if (authState.status == AuthStatus.unauthenticated) {
      if (!isAuthRoute) {
        return '/login'; // Unauthenticated users sent to login from any protected route/splash
      }
      return null;
    }

    if (authState.status == AuthStatus.needsEmailVerification) {
      return null; // Stay wherever we are (VerifyEmailScreen via Navigator.push)
    }

    return null;
  }
}

// Observe the state from the AuthController to reactively re-evaluate routing
final authGuardProvider = Provider<AuthGuard>((ref) {
  return AuthGuard(ref);
});
