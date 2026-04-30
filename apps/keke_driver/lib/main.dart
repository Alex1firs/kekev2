import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:firebase_core/firebase_core.dart';
import 'core/routing/app_router.dart';
import 'core/theme/app_theme.dart';
import 'core/network/notification_service.dart';
import 'core/services/location_foreground_task.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  initForegroundTask();
  
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
