import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import '../application/auth_controller.dart';
import '../domain/auth_state.dart';
import '../../../core/theme/app_theme.dart';
import 'forgot_password_screen.dart';
import 'verify_email_screen.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  bool _obscurePassword = true;

  @override
  void dispose() {
    _emailController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  String? _validateEmail(String? v) {
    if (v == null || v.trim().isEmpty) return 'Email is required';
    if (!RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(v.trim())) {
      return 'Enter a valid email address';
    }
    return null;
  }

  String? _validatePassword(String? v) {
    if (v == null || v.isEmpty) return 'Password is required';
    if (v.length < 8) return 'Password must be at least 8 characters';
    return null;
  }

  void _submit() {
    if (!_formKey.currentState!.validate()) return;
    FocusScope.of(context).unfocus();
    ref.read(authControllerProvider.notifier).login(
      _emailController.text.trim(),
      _passwordController.text,
    );
  }

  @override
  Widget build(BuildContext context) {
    final authState = ref.watch(authControllerProvider);
    final isBusy = authState.status == AuthStatus.authenticating ||
                   authState.status == AuthStatus.transitioning;

    ref.listen(authControllerProvider, (_, next) {
      if (next.status == AuthStatus.needsEmailVerification) {
        Navigator.push(
          context,
          MaterialPageRoute(
            builder: (_) => VerifyEmailScreen(
              email: next.pendingEmail ?? '',
              devOtp: next.devOtp,
            ),
          ),
        );
      }
    });

    return Scaffold(
      backgroundColor: AppColors.white,
      body: SafeArea(
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Container(
                color: AppColors.charcoal,
                padding: const EdgeInsets.fromLTRB(28, 48, 28, 40),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Container(
                      width: 52,
                      height: 52,
                      decoration: BoxDecoration(
                        color: AppColors.primary,
                        borderRadius: BorderRadius.circular(14),
                      ),
                      child: const Icon(Icons.electric_rickshaw, size: 30, color: AppColors.charcoal),
                    ),
                    const SizedBox(height: 24),
                    Text('Driver Login', style: GoogleFonts.plusJakartaSans(
                      fontSize: 28, fontWeight: FontWeight.w800, color: AppColors.white, height: 1.2)),
                    const SizedBox(height: 6),
                    Text('Sign in to start earning', style: GoogleFonts.plusJakartaSans(
                      fontSize: 14, color: AppColors.midGray)),
                  ],
                ),
              ),

              Padding(
                padding: const EdgeInsets.fromLTRB(24, 32, 24, 24),
                child: Form(
                  key: _formKey,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      if (authState.status == AuthStatus.error) ...[
                        _ErrorBanner(message: authState.errorMessage ?? 'Authentication failed'),
                        const SizedBox(height: 20),
                      ],

                      _FieldLabel(text: 'Email Address'),
                      const SizedBox(height: 6),
                      TextFormField(
                        controller: _emailController,
                        decoration: const InputDecoration(
                          hintText: 'you@example.com',
                          prefixIcon: Icon(Icons.email_outlined),
                        ),
                        keyboardType: TextInputType.emailAddress,
                        enabled: !isBusy,
                        validator: _validateEmail,
                        textInputAction: TextInputAction.next,
                      ),
                      const SizedBox(height: 20),

                      _FieldLabel(text: 'Password'),
                      const SizedBox(height: 6),
                      TextFormField(
                        controller: _passwordController,
                        decoration: InputDecoration(
                          hintText: 'Enter your password',
                          prefixIcon: const Icon(Icons.lock_outline),
                          suffixIcon: IconButton(
                            icon: Icon(_obscurePassword ? Icons.visibility_off_outlined : Icons.visibility_outlined),
                            onPressed: () => setState(() => _obscurePassword = !_obscurePassword),
                          ),
                        ),
                        obscureText: _obscurePassword,
                        enabled: !isBusy,
                        validator: _validatePassword,
                        textInputAction: TextInputAction.done,
                        onFieldSubmitted: (_) => _submit(),
                      ),
                      const SizedBox(height: 8),
                      Align(
                        alignment: Alignment.centerRight,
                        child: TextButton(
                          onPressed: isBusy ? null : () => Navigator.push(
                            context, MaterialPageRoute(builder: (_) => const ForgotPasswordScreen())),
                          child: const Text('Forgot Password?'),
                        ),
                      ),
                      const SizedBox(height: 24),

                      ElevatedButton(
                        onPressed: isBusy ? null : _submit,
                        child: isBusy
                            ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2.5, color: AppColors.charcoal))
                            : const Text('Sign In'),
                      ),
                      const SizedBox(height: 20),

                      Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Text("Don't have an account? ", style: AppTextStyles.bodySmall()),
                          GestureDetector(
                            onTap: isBusy ? null : () => context.push('/signup'),
                            child: Text('Sign up', style: AppTextStyles.bodySmall(
                              color: AppColors.primaryDark, weight: FontWeight.w700)),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _FieldLabel extends StatelessWidget {
  final String text;
  const _FieldLabel({required this.text});

  @override
  Widget build(BuildContext context) {
    return Text(text, style: AppTextStyles.label(color: AppColors.darkGray, weight: FontWeight.w600));
  }
}

class _ErrorBanner extends StatelessWidget {
  final String message;
  const _ErrorBanner({required this.message});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: AppColors.errorLight,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppColors.error.withOpacity(0.3)),
      ),
      child: Row(
        children: [
          const Icon(Icons.error_outline, color: AppColors.error, size: 18),
          const SizedBox(width: 10),
          Expanded(child: Text(message, style: AppTextStyles.bodySmall(color: AppColors.error))),
        ],
      ),
    );
  }
}
