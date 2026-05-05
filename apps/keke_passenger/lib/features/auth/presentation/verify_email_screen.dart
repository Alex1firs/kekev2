import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import 'dart:async';
import '../application/auth_controller.dart';
import '../domain/auth_state.dart';
import '../../../core/theme/app_theme.dart';

class VerifyEmailScreen extends ConsumerStatefulWidget {
  final String email;
  final String? devOtp;

  const VerifyEmailScreen({super.key, required this.email, this.devOtp});

  @override
  ConsumerState<VerifyEmailScreen> createState() => _VerifyEmailScreenState();
}

class _VerifyEmailScreenState extends ConsumerState<VerifyEmailScreen> {
  final _formKey = GlobalKey<FormState>();
  final _otpController = TextEditingController();
  String? _error;
  String? _successMessage;
  String? _displayDevOtp;
  int _resendCooldown = 0;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _displayDevOtp = widget.devOtp;
  }

  @override
  void dispose() {
    _otpController.dispose();
    _timer?.cancel();
    super.dispose();
  }

  void _startCooldown() {
    setState(() => _resendCooldown = 60);
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (_resendCooldown <= 1) {
        t.cancel();
        setState(() => _resendCooldown = 0);
      } else {
        setState(() => _resendCooldown--);
      }
    });
  }

  Future<void> _resend() async {
    setState(() { _error = null; _successMessage = null; });
    final err = await ref.read(authControllerProvider.notifier)
        .resendVerificationOtp(widget.email);
    if (err != null) {
      setState(() => _error = err);
    } else {
      _startCooldown();
      final newDevOtp = ref.read(authControllerProvider).devOtp;
      setState(() {
        _successMessage = 'A new code has been sent.';
        _displayDevOtp = newDevOtp;
      });
    }
  }

  void _submit() {
    if (!_formKey.currentState!.validate()) return;
    FocusScope.of(context).unfocus();
    setState(() => _error = null);
    ref.read(authControllerProvider.notifier)
        .verifyEmail(widget.email, _otpController.text.trim());
  }

  @override
  Widget build(BuildContext context) {
    final authState = ref.watch(authControllerProvider);
    final isBusy = authState.status == AuthStatus.authenticating ||
        authState.status == AuthStatus.transitioning;

    ref.listen(authControllerProvider, (_, next) {
      if (next.status == AuthStatus.needsEmailVerification && next.errorMessage != null) {
        setState(() => _error = next.errorMessage);
      }
    });

    return Scaffold(
      backgroundColor: AppColors.white,
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(
              color: AppColors.charcoal,
              padding: const EdgeInsets.fromLTRB(24, 32, 24, 32),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  GestureDetector(
                    onTap: isBusy ? null : () => Navigator.pop(context),
                    child: const Icon(Icons.arrow_back, color: AppColors.white),
                  ),
                  const SizedBox(height: 20),
                  Container(
                    width: 52,
                    height: 52,
                    decoration: BoxDecoration(
                      color: AppColors.primary.withOpacity(0.2),
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: const Icon(Icons.mark_email_read_outlined,
                        color: AppColors.primary, size: 28),
                  ),
                  const SizedBox(height: 16),
                  Text('Verify your email',
                      style: GoogleFonts.plusJakartaSans(
                          fontSize: 26,
                          fontWeight: FontWeight.w800,
                          color: AppColors.white,
                          height: 1.2)),
                  const SizedBox(height: 6),
                  RichText(
                    text: TextSpan(
                      style: GoogleFonts.plusJakartaSans(
                          fontSize: 14, color: AppColors.midGray),
                      children: [
                        const TextSpan(text: 'We sent a 6-digit code to '),
                        TextSpan(
                          text: widget.email,
                          style: GoogleFonts.plusJakartaSans(
                              color: AppColors.primaryLight,
                              fontWeight: FontWeight.w600),
                        ),
                      ],
                    ),
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
                      const SizedBox(height: 16),
                    ],
                    if (_successMessage != null) ...[
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 14, vertical: 12),
                        decoration: BoxDecoration(
                          color: AppColors.primaryLight.withOpacity(0.15),
                          borderRadius: BorderRadius.circular(10),
                          border: Border.all(
                              color: AppColors.primary.withOpacity(0.3)),
                        ),
                        child: Row(
                          children: [
                            const Icon(Icons.check_circle_outline,
                                color: AppColors.primary, size: 18),
                            const SizedBox(width: 10),
                            Expanded(
                                child: Text(_successMessage!,
                                    style: AppTextStyles.bodySmall(
                                        color: AppColors.primaryDark))),
                          ],
                        ),
                      ),
                      const SizedBox(height: 16),
                    ],
                    if (_displayDevOtp != null) ...[
                      Container(
                        padding: const EdgeInsets.all(14),
                        decoration: BoxDecoration(
                          color: AppColors.primaryLight.withOpacity(0.12),
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(
                              color: AppColors.primary.withOpacity(0.4)),
                        ),
                        child: Row(
                          children: [
                            const Icon(Icons.developer_mode,
                                color: AppColors.primaryDark, size: 18),
                            const SizedBox(width: 10),
                            Text('DEV CODE: $_displayDevOtp',
                                style: AppTextStyles.body(
                                    color: AppColors.primaryDark,
                                    weight: FontWeight.w700)),
                          ],
                        ),
                      ),
                      const SizedBox(height: 20),
                    ],
                    Text('Verification Code',
                        style: AppTextStyles.label(
                            color: AppColors.darkGray,
                            weight: FontWeight.w600)),
                    const SizedBox(height: 6),
                    Form(
                      key: _formKey,
                      child: TextFormField(
                        controller: _otpController,
                        keyboardType: TextInputType.number,
                        enabled: !isBusy,
                        maxLength: 6,
                        decoration: const InputDecoration(
                          hintText: '6-digit code',
                          prefixIcon: Icon(Icons.pin_outlined),
                          counterText: '',
                        ),
                        style: const TextStyle(
                            fontSize: 22,
                            fontWeight: FontWeight.w700,
                            letterSpacing: 6),
                        validator: (v) {
                          if (v == null || v.trim().length != 6) {
                            return 'Enter the 6-digit code';
                          }
                          return null;
                        },
                      ),
                    ),
                    const SizedBox(height: 28),
                    ElevatedButton(
                      onPressed: isBusy ? null : _submit,
                      child: isBusy
                          ? const SizedBox(
                              height: 20,
                              width: 20,
                              child: CircularProgressIndicator(
                                  strokeWidth: 2.5,
                                  color: AppColors.charcoal))
                          : const Text('Verify Email'),
                    ),
                    const SizedBox(height: 20),
                    Center(
                      child: _resendCooldown > 0
                          ? Text(
                              'Resend code in ${_resendCooldown}s',
                              style: AppTextStyles.bodySmall(
                                  color: AppColors.midGray),
                            )
                          : TextButton(
                              onPressed: isBusy ? null : _resend,
                              child: Text(
                                "Didn't receive a code? Resend",
                                style: AppTextStyles.bodySmall(
                                    color: AppColors.primaryDark,
                                    weight: FontWeight.w600),
                              ),
                            ),
                    ),
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
