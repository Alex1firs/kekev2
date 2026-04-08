import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../features/auth/application/auth_controller.dart';
import '../../features/auth/domain/auth_state.dart';
import '../../features/driver/application/driver_controller.dart';
import '../../features/driver/domain/driver_profile.dart';
import '../../features/driver/domain/driver_state.dart';

class AuthGuard {
  final AuthState authState;
  final DriverState driverState;

  AuthGuard({required this.authState, required this.driverState});

  String? redirectHook(BuildContext context, GoRouterState state) {
    final loc = state.matchedLocation;
    final isSplash = loc == '/splash';
    final isAuthRoute = loc == '/login' || loc == '/signup';
    final isOnboarding = loc == '/onboarding';
    final isStatusPage = loc == '/status';

    // 1. Initializing state
    if (authState.status == AuthStatus.initializing) {
      return isSplash ? null : '/splash';
    }

    // 2. Unauthenticated state
    if (authState.status == AuthStatus.unauthenticated) {
      if (!isAuthRoute && !isSplash) return '/login';
      return null;
    }

    // 3. Authenticated state - Handle Driver Status
    if (authState.status == AuthStatus.authenticated) {
      final status = driverState.profile.status;

      if (status == DriverStatus.unregistered) {
        if (!isOnboarding) return '/onboarding';
        return null;
      }

      if (status == DriverStatus.pendingApproval || 
          status == DriverStatus.suspended || 
          status == DriverStatus.rejected) {
        if (!isStatusPage) return '/status';
        return null;
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

// Observe both Auth and Driver states
final authGuardProvider = Provider<AuthGuard>((ref) {
  final authState = ref.watch(authControllerProvider);
  final driverState = ref.watch(driverControllerProvider);
  return AuthGuard(authState: authState, driverState: driverState);
});

