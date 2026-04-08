import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'core/routing/app_router.dart';
import 'core/theme/app_theme.dart';

void main() {
  runApp(
    const ProviderScope(
      child: KekeDriverApp(),
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
