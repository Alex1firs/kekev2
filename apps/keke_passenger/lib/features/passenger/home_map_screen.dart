import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../auth/application/auth_controller.dart';

class HomeMapScreen extends ConsumerWidget {
  const HomeMapScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      extendBodyBehindAppBar: true,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        actions: [
          IconButton(
            icon: const Icon(Icons.logout, color: Colors.black87),
            onPressed: () {
              ref.read(authControllerProvider.notifier).logout();
            },
            tooltip: 'Logout',
          )
        ],
      ),
      body: Stack(
        children: [
          // Placeholder for google_maps_flutter widget
          Container(
            color: Colors.grey.shade300,
            child: const Center(
              child: Text('Map Canvas Placeholder'),
            ),
          ),
          
          // Sheet-first placeholder bottom sheet
          Positioned(
            bottom: 0,
            left: 0,
            right: 0,
            child: Container(
              height: 200,
              decoration: const BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.only(
                  topLeft: Radius.circular(20),
                  topRight: Radius.circular(20),
                ),
                boxShadow: [
                  BoxShadow(color: Colors.black12, blurRadius: 10),
                ]
              ),
              child: const Center(child: Text('Request Sheet Placeholder')),
            ),
          )
        ],
      ),
    );
  }
}
