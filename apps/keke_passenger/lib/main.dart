import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'core/routing/app_router.dart';
import 'core/theme/app_theme.dart';
import 'core/network/notification_service.dart';
import 'features/auth/application/auth_controller.dart';
import 'features/auth/domain/auth_state.dart';
import 'features/passenger/application/booking_controller.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  
  final container = ProviderContainer();
  // Initialize Push Notifications (Basic init)
  final notificationService = container.read(notificationServiceProvider('passenger'));
  await notificationService.initialize();

  runApp(
    UncontrolledProviderScope(
      container: container,
      child: const KekePassengerApp(),
    ),
  );
}

/// Root widget, and the app's only lifecycle observer.
///
/// ── Why this exists ─────────────────────────────────────────────────────
/// The passenger app had no `WidgetsBindingObserver` anywhere. Nothing ran
/// when the app returned to the foreground, so a passenger who backgrounded
/// KekeRide while a driver was en route and came back after the driver had
/// arrived saw the old state until a socket event happened to arrive.
///
/// Resume is one of the triggers for the single active-ride recovery path; it
/// does not have its own logic. See active_ride_recovery.dart.
class KekePassengerApp extends ConsumerStatefulWidget {
  const KekePassengerApp({super.key});

  @override
  ConsumerState<KekePassengerApp> createState() => _KekePassengerAppState();
}

class _KekePassengerAppState extends ConsumerState<KekePassengerApp>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState lifecycleState) {
    if (lifecycleState != AppLifecycleState.resumed) return;

    // Only meaningful for a signed-in passenger. Reading the controller before
    // authentication would build it with an unknown id, and it would correctly
    // decline to recover anything.
    final auth = ref.read(authControllerProvider);
    if (auth.status != AuthStatus.authenticated) return;

    ref.read(bookingControllerProvider.notifier).onAppResumed();
  }

  @override
  Widget build(BuildContext context) {
    final router = ref.watch(appRouterProvider);

    return MaterialApp.router(
      title: 'Keke Passenger',
      theme: AppTheme.lightTheme,
      darkTheme: AppTheme.darkTheme,
      themeMode: ThemeMode.system,
      routerConfig: router,
    );
  }
}
