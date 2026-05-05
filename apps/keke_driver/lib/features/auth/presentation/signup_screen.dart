import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import '../application/auth_controller.dart';
import '../domain/auth_state.dart';
import '../../../core/theme/app_theme.dart';
import 'verify_email_screen.dart';

class SignupScreen extends ConsumerStatefulWidget {
  const SignupScreen({super.key});

  @override
  ConsumerState<SignupScreen> createState() => _SignupScreenState();
}

class _SignupScreenState extends ConsumerState<SignupScreen> {
  final _formKey = GlobalKey<FormState>();
  final _firstNameController = TextEditingController();
  final _lastNameController = TextEditingController();
  final _emailController = TextEditingController();
  final _phoneController = TextEditingController();
  final _passwordController = TextEditingController();
  final _confirmPasswordController = TextEditingController();
  bool _obscurePassword = true;
  bool _obscureConfirm = true;

  @override
  void dispose() {
    _firstNameController.dispose();
    _lastNameController.dispose();
    _emailController.dispose();
    _phoneController.dispose();
    _passwordController.dispose();
    _confirmPasswordController.dispose();
    super.dispose();
  }

  String? _validateName(String? v, String label) {
    if (v == null || v.trim().isEmpty) return '$label is required';
    if (v.trim().length < 2) return '$label must be at least 2 characters';
    return null;
  }

  String? _validateEmail(String? v) {
    if (v == null || v.trim().isEmpty) return 'Email is required';
    if (!RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(v.trim())) {
      return 'Enter a valid email address';
    }
    return null;
  }

  String? _validatePhone(String? v) {
    if (v == null || v.trim().isEmpty) return 'Phone number is required';
    final c = v.trim().replaceAll(RegExp(r'[\s\-()]'), '');
    if (!RegExp(r'^(\+?234|0)[789]\d{9}$').hasMatch(c)) {
      return 'Enter a valid Nigerian phone number (e.g. 08012345678)';
    }
    return null;
  }

  String? _validatePassword(String? v) {
    if (v == null || v.isEmpty) return 'Password is required';
    if (v.length < 8) return 'Password must be at least 8 characters';
    return null;
  }

  String? _validateConfirmPassword(String? v) {
    if (v == null || v.isEmpty) return 'Please confirm your password';
    if (v != _passwordController.text) return 'Passwords do not match';
    return null;
  }

  void _submit() {
    if (!_formKey.currentState!.validate()) return;
    FocusScope.of(context).unfocus();
    ref.read(authControllerProvider.notifier).signup(
      _emailController.text.trim(),
      _passwordController.text,
      _firstNameController.text.trim(),
      _lastNameController.text.trim(),
      _phoneController.text.trim(),
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
                padding: const EdgeInsets.fromLTRB(28, 40, 28, 32),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    GestureDetector(
                      onTap: () => context.pop(),
                      child: const Icon(Icons.arrow_back, color: AppColors.white),
                    ),
                    const SizedBox(height: 20),
                    Text('Driver Sign Up', style: GoogleFonts.plusJakartaSans(
                      fontSize: 28, fontWeight: FontWeight.w800, color: AppColors.white, height: 1.2)),
                    const SizedBox(height: 6),
                    Text('Start earning with Keke', style: GoogleFonts.plusJakartaSans(
                      fontSize: 14, color: AppColors.midGray)),
                  ],
                ),
              ),

              Padding(
                padding: const EdgeInsets.fromLTRB(24, 28, 24, 24),
                child: Form(
                  key: _formKey,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      if (authState.status == AuthStatus.error) ...[
                        _ErrorBanner(message: authState.errorMessage ?? 'Signup failed'),
                        const SizedBox(height: 20),
                      ],

                      Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                _FieldLabel(text: 'First Name'),
                                const SizedBox(height: 6),
                                TextFormField(
                                  controller: _firstNameController,
                                  decoration: const InputDecoration(hintText: 'e.g. Emeka'),
                                  enabled: !isBusy,
                                  textCapitalization: TextCapitalization.words,
                                  validator: (v) => _validateName(v, 'First name'),
                                  textInputAction: TextInputAction.next,
                                ),
                              ],
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                _FieldLabel(text: 'Last Name'),
                                const SizedBox(height: 6),
                                TextFormField(
                                  controller: _lastNameController,
                                  decoration: const InputDecoration(hintText: 'e.g. Okonkwo'),
                                  enabled: !isBusy,
                                  textCapitalization: TextCapitalization.words,
                                  validator: (v) => _validateName(v, 'Last name'),
                                  textInputAction: TextInputAction.next,
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 20),

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

                      _FieldLabel(text: 'Phone Number'),
                      const SizedBox(height: 6),
                      TextFormField(
                        controller: _phoneController,
                        decoration: const InputDecoration(
                          hintText: '08012345678',
                          prefixIcon: Icon(Icons.phone_outlined),
                        ),
                        keyboardType: TextInputType.phone,
                        enabled: !isBusy,
                        validator: _validatePhone,
                        textInputAction: TextInputAction.next,
                      ),
                      const SizedBox(height: 20),

                      _FieldLabel(text: 'Password'),
                      const SizedBox(height: 6),
                      TextFormField(
                        controller: _passwordController,
                        decoration: InputDecoration(
                          hintText: 'Min. 8 characters',
                          prefixIcon: const Icon(Icons.lock_outline),
                          suffixIcon: IconButton(
                            icon: Icon(_obscurePassword ? Icons.visibility_off_outlined : Icons.visibility_outlined),
                            onPressed: () => setState(() => _obscurePassword = !_obscurePassword),
                          ),
                        ),
                        obscureText: _obscurePassword,
                        enabled: !isBusy,
                        validator: _validatePassword,
                        textInputAction: TextInputAction.next,
                      ),
                      const SizedBox(height: 20),

                      _FieldLabel(text: 'Confirm Password'),
                      const SizedBox(height: 6),
                      TextFormField(
                        controller: _confirmPasswordController,
                        decoration: InputDecoration(
                          hintText: 'Re-enter your password',
                          prefixIcon: const Icon(Icons.lock_outline),
                          suffixIcon: IconButton(
                            icon: Icon(_obscureConfirm ? Icons.visibility_off_outlined : Icons.visibility_outlined),
                            onPressed: () => setState(() => _obscureConfirm = !_obscureConfirm),
                          ),
                        ),
                        obscureText: _obscureConfirm,
                        enabled: !isBusy,
                        validator: _validateConfirmPassword,
                        textInputAction: TextInputAction.done,
                        onFieldSubmitted: (_) => _submit(),
                      ),
                      const SizedBox(height: 28),

                      ElevatedButton(
                        onPressed: isBusy ? null : _submit,
                        child: isBusy
                            ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2.5, color: AppColors.charcoal))
                            : const Text('Create Account'),
                      ),
                      const SizedBox(height: 20),

                      Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Text('Already have an account? ', style: AppTextStyles.bodySmall()),
                          GestureDetector(
                            onTap: isBusy ? null : () => context.pop(),
                            child: Text('Sign in', style: AppTextStyles.bodySmall(
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
