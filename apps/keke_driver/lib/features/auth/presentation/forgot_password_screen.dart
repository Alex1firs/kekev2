import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../../../core/theme/app_theme.dart';
import '../data/auth_repository.dart';
import '../../../core/storage/secure_storage.dart';

class ForgotPasswordScreen extends ConsumerStatefulWidget {
  const ForgotPasswordScreen({super.key});

  @override
  ConsumerState<ForgotPasswordScreen> createState() =>
      _ForgotPasswordScreenState();
}

class _ForgotPasswordScreenState extends ConsumerState<ForgotPasswordScreen> {
  final _emailFormKey = GlobalKey<FormState>();
  final _resetFormKey = GlobalKey<FormState>();
  final _emailCtrl = TextEditingController();
  final _otpCtrl = TextEditingController();
  final _newPassCtrl = TextEditingController();
  final _confirmPassCtrl = TextEditingController();

  bool _otpSent = false;
  bool _isBusy = false;
  String? _error;
  String? _devOtp;
  bool _obscureNew = true;
  bool _obscureConfirm = true;

  @override
  void dispose() {
    _emailCtrl.dispose();
    _otpCtrl.dispose();
    _newPassCtrl.dispose();
    _confirmPassCtrl.dispose();
    super.dispose();
  }

  String? _validateEmail(String? v) {
    if (v == null || v.trim().isEmpty) return 'Email is required';
    if (!RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(v.trim())) {
      return 'Enter a valid email address';
    }
    return null;
  }

  Future<void> _requestOtp() async {
    if (!_emailFormKey.currentState!.validate()) return;
    setState(() {
      _isBusy = true;
      _error = null;
    });
    try {
      final result = await ref
          .read(authRepositoryProvider)
          .requestPasswordReset(_emailCtrl.text.trim());
      setState(() {
        _otpSent = true;
        _devOtp = result['otp'] as String?;
        _isBusy = false;
      });
    } catch (e) {
      setState(() {
        _error = e.toString().replaceFirst('Exception: ', '');
        _isBusy = false;
      });
    }
  }

  Future<void> _confirmReset() async {
    if (!_resetFormKey.currentState!.validate()) return;
    setState(() {
      _isBusy = true;
      _error = null;
    });
    try {
      final token = await ref.read(authRepositoryProvider).confirmPasswordReset(
            _emailCtrl.text.trim(),
            _otpCtrl.text.trim(),
            _newPassCtrl.text,
          );
      await ref.read(secureStorageServiceProvider).writeToken(token);
      if (!mounted) return;
      context.go('/home');
    } catch (e) {
      setState(() {
        _error = e.toString().replaceFirst('Exception: ', '');
        _isBusy = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.white,
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Header
            Container(
              color: AppColors.charcoal,
              padding: const EdgeInsets.fromLTRB(24, 32, 24, 28),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  GestureDetector(
                    onTap: () => Navigator.pop(context),
                    child: const Icon(Icons.arrow_back, color: AppColors.white),
                  ),
                  const SizedBox(height: 20),
                  Container(
                    width: 48,
                    height: 48,
                    decoration: BoxDecoration(
                      color: AppColors.primary.withOpacity(0.2),
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: const Icon(Icons.lock_reset_rounded,
                        color: AppColors.primary, size: 26),
                  ),
                  const SizedBox(height: 16),
                  Text(
                    _otpSent ? 'Set New Password' : 'Reset Password',
                    style: AppTextStyles.headline(color: AppColors.white),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    _otpSent
                        ? 'Enter the OTP sent to ${_emailCtrl.text.trim()}'
                        : 'We\'ll send an OTP to your registered email',
                    style: AppTextStyles.body(color: AppColors.midGray),
                  ),
                ],
              ),
            ),

            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(24, 28, 24, 24),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (_error != null) ...[
                      _ErrorBanner(message: _error!),
                      const SizedBox(height: 20),
                    ],

                    if (_devOtp != null) ...[
                      Container(
                        padding: const EdgeInsets.all(14),
                        decoration: BoxDecoration(
                          color: AppColors.primaryLight,
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(color: AppColors.primary.withOpacity(0.4)),
                        ),
                        child: Row(
                          children: [
                            const Icon(Icons.developer_mode, color: AppColors.primaryDark, size: 18),
                            const SizedBox(width: 10),
                            Text(
                              'DEV OTP: $_devOtp',
                              style: AppTextStyles.body(
                                  color: AppColors.primaryDark,
                                  weight: FontWeight.w700),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 20),
                    ],

                    if (!_otpSent) ...[
                      _FieldLabel(text: 'Email Address'),
                      const SizedBox(height: 6),
                      Form(
                        key: _emailFormKey,
                        child: TextFormField(
                          controller: _emailCtrl,
                          keyboardType: TextInputType.emailAddress,
                          enabled: !_isBusy,
                          decoration: const InputDecoration(
                            hintText: 'you@example.com',
                            prefixIcon: Icon(Icons.email_outlined),
                          ),
                          validator: _validateEmail,
                        ),
                      ),
                      const SizedBox(height: 28),
                      ElevatedButton(
                        onPressed: _isBusy ? null : _requestOtp,
                        child: _isBusy
                            ? const SizedBox(
                                width: 20,
                                height: 20,
                                child: CircularProgressIndicator(
                                    strokeWidth: 2.5, color: AppColors.charcoal))
                            : const Text('Send OTP'),
                      ),
                    ] else ...[
                      Form(
                        key: _resetFormKey,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            _FieldLabel(text: 'OTP Code'),
                            const SizedBox(height: 6),
                            TextFormField(
                              controller: _otpCtrl,
                              keyboardType: TextInputType.number,
                              enabled: !_isBusy,
                              decoration: const InputDecoration(
                                hintText: '6-digit code',
                                prefixIcon: Icon(Icons.pin_outlined),
                              ),
                              validator: (v) {
                                if (v == null || v.trim().length != 6) {
                                  return 'Enter the 6-digit OTP';
                                }
                                return null;
                              },
                            ),
                            const SizedBox(height: 20),
                            _FieldLabel(text: 'New Password'),
                            const SizedBox(height: 6),
                            TextFormField(
                              controller: _newPassCtrl,
                              enabled: !_isBusy,
                              obscureText: _obscureNew,
                              decoration: InputDecoration(
                                hintText: 'Min. 8 characters',
                                prefixIcon: const Icon(Icons.lock_outline),
                                suffixIcon: IconButton(
                                  icon: Icon(_obscureNew
                                      ? Icons.visibility_off_outlined
                                      : Icons.visibility_outlined),
                                  onPressed: () => setState(
                                      () => _obscureNew = !_obscureNew),
                                ),
                              ),
                              validator: (v) {
                                if (v == null || v.length < 8) {
                                  return 'At least 8 characters required';
                                }
                                return null;
                              },
                            ),
                            const SizedBox(height: 20),
                            _FieldLabel(text: 'Confirm Password'),
                            const SizedBox(height: 6),
                            TextFormField(
                              controller: _confirmPassCtrl,
                              enabled: !_isBusy,
                              obscureText: _obscureConfirm,
                              decoration: InputDecoration(
                                hintText: 'Re-enter password',
                                prefixIcon: const Icon(Icons.lock_outline),
                                suffixIcon: IconButton(
                                  icon: Icon(_obscureConfirm
                                      ? Icons.visibility_off_outlined
                                      : Icons.visibility_outlined),
                                  onPressed: () => setState(
                                      () => _obscureConfirm = !_obscureConfirm),
                                ),
                              ),
                              validator: (v) {
                                if (v != _newPassCtrl.text) {
                                  return 'Passwords do not match';
                                }
                                return null;
                              },
                            ),
                            const SizedBox(height: 28),
                            ElevatedButton(
                              onPressed: _isBusy ? null : _confirmReset,
                              child: _isBusy
                                  ? const SizedBox(
                                      width: 20,
                                      height: 20,
                                      child: CircularProgressIndicator(
                                          strokeWidth: 2.5,
                                          color: AppColors.charcoal))
                                  : const Text('Reset Password'),
                            ),
                            const SizedBox(height: 12),
                            TextButton(
                              onPressed: _isBusy
                                  ? null
                                  : () => setState(() {
                                        _otpSent = false;
                                        _error = null;
                                      }),
                              child: Text(
                                'Use a different email',
                                style: AppTextStyles.body(color: AppColors.midGray),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ],
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
    return Text(
      text,
      style: AppTextStyles.label(color: AppColors.darkGray, weight: FontWeight.w600),
    );
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
          Expanded(
              child: Text(message,
                  style: AppTextStyles.bodySmall(color: AppColors.error))),
        ],
      ),
    );
  }
}
