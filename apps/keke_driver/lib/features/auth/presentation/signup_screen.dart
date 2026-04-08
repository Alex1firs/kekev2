import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../application/auth_controller.dart';
import '../domain/auth_state.dart';

class SignupScreen extends ConsumerStatefulWidget {
  const SignupScreen({super.key});

  @override
  ConsumerState<SignupScreen> createState() => _SignupScreenState();
}

class _SignupScreenState extends ConsumerState<SignupScreen> {
  final _phoneController = TextEditingController();
  final _passwordController = TextEditingController();
  final _firstNameController = TextEditingController();
  final _lastNameController = TextEditingController();

  void _submit() {
    FocusScope.of(context).unfocus();
    final fName = _firstNameController.text.trim();
    final lName = _lastNameController.text.trim();
    final phone = _phoneController.text.trim();
    final pwd = _passwordController.text.trim();
    
    if (fName.isNotEmpty && phone.isNotEmpty && pwd.isNotEmpty) {
      ref.read(authControllerProvider.notifier).signup(phone, pwd, fName, lName);
    }
  }

  @override
  Widget build(BuildContext context) {
    final authState = ref.watch(authControllerProvider);
    final isBusy = authState.status == AuthStatus.authenticating || 
                   authState.status == AuthStatus.transitioning;

    return Scaffold(
      appBar: AppBar(title: const Text('Driver Sign Up')),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(24.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const SizedBox(height: 48),
            if (authState.status == AuthStatus.error)
              Padding(
                padding: const EdgeInsets.only(bottom: 16),
                child: Text(
                  authState.errorMessage ?? 'Signup failed',
                  style: const TextStyle(color: Colors.red),
                  textAlign: TextAlign.center,
                ),
              ),

            TextField(
              controller: _firstNameController,
              decoration: const InputDecoration(labelText: 'First Name', border: OutlineInputBorder()),
              enabled: !isBusy,
            ),
            const SizedBox(height: 16),
            TextField(
              controller: _lastNameController,
              decoration: const InputDecoration(labelText: 'Last Name', border: OutlineInputBorder()),
              enabled: !isBusy,
            ),
            const SizedBox(height: 16),
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
                  : const Text('Create Account'),
            ),
            const SizedBox(height: 16),
            TextButton(
              onPressed: isBusy ? null : () => context.pop(),
              child: const Text('Already have an account? Login'),
            )
          ],
        ),
      ),
    );
  }
}
