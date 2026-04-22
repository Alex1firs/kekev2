import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:firebase_core/firebase_core.dart';
import 'core/routing/app_router.dart';
import 'core/theme/app_theme.dart';
import 'core/network/notification_service.dart';

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

class KekePassengerApp extends ConsumerWidget {
  const KekePassengerApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
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
