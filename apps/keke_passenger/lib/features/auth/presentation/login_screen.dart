import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../application/auth_controller.dart';
import '../domain/auth_state.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _phoneController = TextEditingController();
  final _passwordController = TextEditingController();

  void _submit() {
    FocusScope.of(context).unfocus();
    final phone = _phoneController.text.trim();
    final pwd = _passwordController.text.trim();
    if (phone.isNotEmpty && pwd.isNotEmpty) {
      ref.read(authControllerProvider.notifier).login(phone, pwd);
    }
  }

  @override
  Widget build(BuildContext context) {
    final authState = ref.watch(authControllerProvider);
    final isBusy = authState.status == AuthStatus.authenticating || 
                   authState.status == AuthStatus.transitioning;

    return Scaffold(
      appBar: AppBar(title: const Text('Login')),
      body: Padding(
        padding: const EdgeInsets.all(24.0),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Icon(Icons.directions_car, size: 80, color: Colors.amber),
            const SizedBox(height: 32),
            
            if (authState.status == AuthStatus.error)
              Padding(
                padding: const EdgeInsets.only(bottom: 16),
                child: Text(
                  authState.errorMessage ?? 'Authentication failed',
                  style: const TextStyle(color: Colors.red),
                  textAlign: TextAlign.center,
                ),
              ),

            TextField(
              controller: _phoneController,
              decoration: const InputDecoration(labelText: 'Phone Number', border: OutlineInputBorder()),
              keyboardType: TextInputType.phone,
              enabled: !isBusy,
            ),
            const SizedBox(height: 16),
            TextField(
              controller: _passwordController,
              decoration: const InputDecoration(labelText: 'Password', border: OutlineInputBorder()),
              obscureText: true,
              enabled: !isBusy,
            ),
            const SizedBox(height: 24),
            
            ElevatedButton(
              onPressed: isBusy ? null : _submit,
              child: isBusy 
                  ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Text('Login'),
            ),
            const SizedBox(height: 16),
            TextButton(
              onPressed: isBusy ? null : () => context.push('/signup'),
              child: const Text('Don\'t have an account? Sign up'),
            )
          ],
        ),
      ),
    );
  }
}
