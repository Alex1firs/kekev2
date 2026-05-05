import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:flutter/material.dart';
import '../../features/auth/presentation/login_screen.dart';
import '../../features/auth/presentation/signup_screen.dart';
import '../../features/auth/presentation/splash_screen.dart';
import '../../features/auth/presentation/forgot_password_screen.dart';
import '../../features/auth/presentation/verify_email_screen.dart';
import '../../features/passenger/presentation/home_map_screen.dart';
import '../../features/passenger/presentation/wallet_screen.dart';
import '../../features/passenger/presentation/trip_history_screen.dart';
import '../../features/passenger/presentation/profile_screen.dart';
import '../../features/passenger/presentation/destination_search_screen.dart';
import 'auth_guard.dart';

// Provides standard Navigator key to manage app wide redirects safely
final GlobalKey<NavigatorState> rootNavigatorKey = GlobalKey<NavigatorState>();

// SCREENSHOT_MODE initial location — override with --dart-define=INITIAL_ROUTE=/wallet etc.
const _initialRoute = String.fromEnvironment('INITIAL_ROUTE', defaultValue: '/splash');

final appRouterProvider = Provider<GoRouter>((ref) {
  final authStateListener = ref.watch(authGuardProvider);

  return GoRouter(
    navigatorKey: rootNavigatorKey,
    initialLocation: _initialRoute,
    redirect: authStateListener.redirectHook,
    refreshListenable: authStateListener,
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
        path: '/forgot-password',
        name: 'forgot-password',
        builder: (context, state) => const ForgotPasswordScreen(),
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
        path: '/home',
        name: 'home',
        builder: (context, state) => const HomeMapScreen(),
      ),
      GoRoute(
        path: '/wallet',
        name: 'wallet',
        builder: (context, state) => const WalletScreen(),
      ),
      GoRoute(
        path: '/trip-history',
        name: 'trip-history',
        builder: (context, state) => const PassengerTripHistoryScreen(),
      ),
      GoRoute(
        path: '/profile',
        name: 'profile',
        builder: (context, state) => const PassengerProfileScreen(),
      ),
      GoRoute(
        path: '/destination-search',
        name: 'destination-search',
        builder: (context, state) => const DestinationSearchScreen(),
      ),
    ],
  );
});
