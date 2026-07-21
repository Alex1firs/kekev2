import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:firebase_core/firebase_core.dart';
import 'core/routing/app_router.dart';
import 'core/theme/app_theme.dart';
import 'core/network/api_client.dart';
import 'core/services/location_foreground_task.dart';
import 'core/services/ride_notification_service.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  initForegroundTask();
  // Create the high-importance ride channel up front so the very first ride
  // push renders as a loud heads-up over the lock screen.
  await RideNotificationService.instance.initialize();

  final container = ProviderContainer();
  final notificationService = container.read(notificationServiceProvider('driver'));
  await notificationService.initialize();

  runApp(
    UncontrolledProviderScope(
      container: container,
      child: const KekeDriverApp(),
    ),
  );
}

class KekeDriverApp extends ConsumerWidget {
  const KekeDriverApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(appRouterProvider);

    // Using dark theme strongly for drivers to reduce glare outdoors
    return MaterialApp.router(
      title: 'Keke Driver',
      theme: AppTheme.lightTheme,
      darkTheme: AppTheme.darkTheme,
      themeMode: ThemeMode.dark, // Driver default bias
      routerConfig: router,
    );
  }
}
