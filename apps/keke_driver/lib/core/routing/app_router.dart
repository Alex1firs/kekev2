import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../features/auth/presentation/login_screen.dart';
import '../../features/auth/presentation/signup_screen.dart';
import '../../features/auth/presentation/splash_screen.dart';
import '../../features/auth/presentation/verify_email_screen.dart';
import '../../features/driver/presentation/onboarding_screen.dart';
import '../../features/driver/presentation/status_info_screen.dart';
import '../../features/driver/presentation/driver_home_screen.dart';
import 'auth_guard.dart';

final rootNavigatorKey = GlobalKey<NavigatorState>();

final appRouterProvider = Provider<GoRouter>((ref) {
  final authGuard = ref.watch(authGuardProvider);

  return GoRouter(
    navigatorKey: rootNavigatorKey,
    initialLocation: '/splash',
    redirect: authGuard.redirectHook,
    refreshListenable: authGuard,
    routes: [
      GoRoute(
        path: '/splash',
        name: 'splash',
        builder: (context, state) => const SplashScreen(),
      ),
      GoRoute(
        path: '/login',
        name: 'login',
        builder: (context, state) => const LoginScreen(),
      ),
      GoRoute(
        path: '/signup',
        name: 'signup',
        builder: (context, state) => const SignupScreen(),
      ),
      GoRoute(
        path: '/verify-email',
        name: 'verify-email',
        builder: (context, state) {
          final extra = state.extra as Map<String, dynamic>?;
          return VerifyEmailScreen(
            email: extra?['email'] as String? ?? '',
            devOtp: extra?['devOtp'] as String?,
          );
        },
      ),
      GoRoute(
        path: '/onboarding',
        name: 'onboarding',
        builder: (context, state) => const OnboardingScreen(),
      ),
      GoRoute(
        path: '/status',
        name: 'status',
        builder: (context, state) => const StatusInfoScreen(),
      ),
      GoRoute(
        path: '/home',
        name: 'home',
        builder: (context, state) => const DriverHomeScreen(),
      ),
    ],
  );
});

