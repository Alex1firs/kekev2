import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../features/auth/application/auth_controller.dart';
import '../../features/auth/domain/auth_state.dart';
import '../../features/driver/application/driver_controller.dart';
import '../../features/driver/domain/driver_profile.dart';
import '../../features/driver/domain/driver_state.dart';

class AuthGuard extends ChangeNotifier {
  final Ref _ref;

  AuthGuard(this._ref) {
    // Only notify GoRouter when routing-relevant state changes, not on every
    // isLoading or ride-data update (those would re-navigate while typing).
    _ref.listen(
      authControllerProvider.select((s) => s.status),
      (_, __) => notifyListeners(),
    );
    _ref.listen(
      driverControllerProvider.select((s) => s.profile.status),
      (_, __) => notifyListeners(),
    );
    _ref.listen(
      driverControllerProvider.select((s) => s.isLoading),
      (_, __) => notifyListeners(),
    );
    _ref.listen(
      driverControllerProvider.select((s) => s.profileLoaded),
      (_, __) => notifyListeners(),
    );
  }

  String? redirectHook(BuildContext context, GoRouterState state) {
    final authState = _ref.read(authControllerProvider);
    final driverState = _ref.read(driverControllerProvider);

    final loc = state.matchedLocation;
    final isSplash = loc == '/splash';
    final isAuthRoute = loc == '/login' ||
                        loc == '/signup' ||
                        loc == '/verify-email' ||
                        loc == '/forgot-password' ||
                        loc == '/welcome';
    final isOnboarding = loc == '/onboarding';
    final isStatusPage = loc == '/status';

    // 1. Initializing state
    if (authState.status == AuthStatus.initializing) {
      return isSplash ? null : '/splash';
    }

    // 2. Needs email verification - stay wherever we are
    if (authState.status == AuthStatus.needsEmailVerification) {
      return null;
    }

    // 3. Unauthenticated state
    if (authState.status == AuthStatus.unauthenticated) {
      if (!isAuthRoute) return '/welcome';
      return null;
    }

    // 4. Authenticated state - Handle Driver Status
    if (authState.status == AuthStatus.authenticated) {
      final status = driverState.profile.status;

      // The profile status has not been confirmed by the server yet (fetch in
      // flight, or it failed and is retrying). Hold on /splash rather than
      // guessing — an unconfirmed `unregistered`/`pendingDocuments` here would
      // misroute an already-onboarded driver to /onboarding.
      if (!driverState.profileLoaded &&
          (status == DriverStatus.unregistered ||
              status == DriverStatus.pendingDocuments)) {
        return isSplash ? null : '/splash';
      }

      if (status == DriverStatus.unregistered || status == DriverStatus.pendingDocuments) {
        if (!isOnboarding) return '/onboarding';
        return null;
      }

      if (status == DriverStatus.pendingApproval || 
          status == DriverStatus.suspended) {
        if (!isStatusPage) return '/status';
        return null;
      }

      if (status == DriverStatus.rejected) {
        if (isOnboarding || isStatusPage) return null;
        return '/status';
      }

      if (status == DriverStatus.approved) {
        if (isAuthRoute || isSplash || isOnboarding || isStatusPage) {
          return '/home';
        }
        return null;
      }
    }

    return null;
  }
}

final authGuardProvider = Provider<AuthGuard>((ref) {
  return AuthGuard(ref);
});

