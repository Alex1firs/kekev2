import 'package:flutter/material.dart';

class LoginScreen extends StatelessWidget {
  const LoginScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Login / Signup')),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.directions_car, size: 80, color: Colors.amber),
            const SizedBox(height: 20),
            const Text('Phone + Password Auth Placeholder'),
            const SizedBox(height: 20),
            ElevatedButton(
              onPressed: () {
                // To be implemented in Phase 2
              },
              child: const Text('Login'),
            )
          ],
        ),
      ),
    );
  }
}
