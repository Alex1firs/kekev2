import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import '../application/auth_controller.dart';
import '../domain/auth_state.dart';
import '../../../core/theme/app_theme.dart';
import 'auth_widgets.dart';
import 'forgot_password_screen.dart';
import 'verify_email_screen.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _pageController = PageController();
  int _step = 0;

  final _emailCtrl = TextEditingController();
  final _passwordCtrl = TextEditingController();
  final _emailFocus = FocusNode();
  final _passwordFocus = FocusNode();

  bool _obscure = true;
  String? _emailError;
  String? _passwordError;

  static const _totalSteps = 2;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _emailFocus.requestFocus());
  }

  @override
  void dispose() {
    _pageController.dispose();
    _emailCtrl.dispose();
    _passwordCtrl.dispose();
    _emailFocus.dispose();
    _passwordFocus.dispose();
    super.dispose();
  }

  bool _validateStep() {
    if (_step == 0) {
      final v = _emailCtrl.text.trim();
      if (v.isEmpty) { setState(() => _emailError = 'Email is required'); return false; }
      if (!RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(v)) {
        setState(() => _emailError = 'Enter a valid email address'); return false;
      }
      setState(() => _emailError = null);
      return true;
    } else {
      final v = _passwordCtrl.text;
      if (v.isEmpty) { setState(() => _passwordError = 'Password is required'); return false; }
      if (v.length < 8) { setState(() => _passwordError = 'At least 8 characters'); return false; }
      setState(() => _passwordError = null);
      return true;
    }
  }

  void _next() {
    if (!_validateStep()) return;
    if (_step < _totalSteps - 1) {
      setState(() => _step++);
      _pageController.nextPage(
        duration: const Duration(milliseconds: 420),
        curve: Curves.easeInOutCubic,
      );
      Future.delayed(const Duration(milliseconds: 450), () {
        if (mounted) _passwordFocus.requestFocus();
      });
    } else {
      _submit();
    }
  }

  void _back() {
    if (_step > 0) {
      setState(() => _step--);
      _pageController.previousPage(
        duration: const Duration(milliseconds: 420),
        curve: Curves.easeInOutCubic,
      );
      Future.delayed(const Duration(milliseconds: 450), () {
        if (mounted) _emailFocus.requestFocus();
      });
    } else {
      Navigator.of(context).pop();
    }
  }

  void _submit() {
    FocusScope.of(context).unfocus();
    ref.read(authControllerProvider.notifier).login(
      _emailCtrl.text.trim().toLowerCase(),
      _passwordCtrl.text,
    );
  }

  @override
  Widget build(BuildContext context) {
    final authState = ref.watch(authControllerProvider);
    final isBusy = authState.status == AuthStatus.authenticating ||
        authState.status == AuthStatus.transitioning;

    ref.listen(authControllerProvider, (_, next) {
      if (next.status == AuthStatus.needsEmailVerification && next.pendingEmail != null) {
        Navigator.push(context, MaterialPageRoute(
          builder: (_) => VerifyEmailScreen(email: next.pendingEmail!, devOtp: next.devOtp),
        ));
      }
    });

    return Scaffold(
      backgroundColor: AppColors.charcoal,
      body: SafeArea(
        child: Column(
          children: [
            AuthTopBar(
              step: _step,
              totalSteps: _totalSteps,
              onBack: _back,
            ),
            Expanded(
              child: PageView(
                controller: _pageController,
                physics: const NeverScrollableScrollPhysics(),
                children: [
                  AuthStepPage(
                    question: 'Welcome back!\nWhat\'s your\nemail?',
                    child: _buildField(
                      controller: _emailCtrl,
                      focusNode: _emailFocus,
                      hint: 'you@example.com',
                      keyboardType: TextInputType.emailAddress,
                      error: _emailError,
                      onSubmitted: (_) => _next(),
                    ),
                  ),
                  AuthStepPage(
                    question: 'Now enter\nyour password.',
                    footer: GestureDetector(
                      onTap: () => Navigator.push(context,
                          MaterialPageRoute(builder: (_) => const ForgotPasswordScreen())),
                      child: Text('Forgot password?',
                          style: AppTextStyles.bodySmall(color: AppColors.primary, weight: FontWeight.w600)),
                    ),
                    child: _buildField(
                      controller: _passwordCtrl,
                      focusNode: _passwordFocus,
                      hint: '••••••••',
                      obscure: _obscure,
                      error: _passwordError,
                      onSubmitted: (_) => _next(),
                      suffix: IconButton(
                        icon: Icon(
                          _obscure ? Icons.visibility_off_outlined : Icons.visibility_outlined,
                          color: AppColors.midGray,
                        ),
                        onPressed: () => setState(() => _obscure = !_obscure),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            if (authState.status == AuthStatus.error && authState.errorMessage != null)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 6),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                  decoration: BoxDecoration(
                    color: AppColors.error.withOpacity(0.12),
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: AppColors.error.withOpacity(0.3)),
                  ),
                  child: Row(
                    children: [
                      const Icon(Icons.error_outline, color: AppColors.error, size: 16),
                      const SizedBox(width: 8),
                      Expanded(child: Text(authState.errorMessage!,
                          style: AppTextStyles.bodySmall(color: AppColors.error))),
                    ],
                  ),
                ),
              ),
            AuthBottomBar(
              label: _step == _totalSteps - 1 ? 'Sign In' : 'Continue',
              isBusy: isBusy,
              onTap: _next,
              footerText: "Don't have an account?",
              footerLinkText: 'Sign up',
              onFooterTap: () => context.push('/signup'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildField({
    required TextEditingController controller,
    required FocusNode focusNode,
    required String hint,
    TextInputType keyboardType = TextInputType.text,
    bool obscure = false,
    String? error,
    ValueChanged<String>? onSubmitted,
    Widget? suffix,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        TextField(
          controller: controller,
          focusNode: focusNode,
          keyboardType: keyboardType,
          obscureText: obscure,
          textInputAction: TextInputAction.next,
          autocorrect: false,
          style: GoogleFonts.plusJakartaSans(
            fontSize: 22,
            fontWeight: FontWeight.w600,
            color: AppColors.white,
          ),
          onSubmitted: onSubmitted,
          decoration: InputDecoration(
            hintText: hint,
            hintStyle: GoogleFonts.plusJakartaSans(
              fontSize: 22,
              fontWeight: FontWeight.w600,
              color: AppColors.white.withOpacity(0.18),
            ),
            suffixIcon: suffix,
            enabledBorder: const UnderlineInputBorder(
              borderSide: BorderSide(color: Color(0xFF3A3A5C), width: 1.5),
            ),
            focusedBorder: const UnderlineInputBorder(
              borderSide: BorderSide(color: AppColors.primary, width: 2),
            ),
            errorBorder: const UnderlineInputBorder(
              borderSide: BorderSide(color: AppColors.error, width: 1.5),
            ),
            focusedErrorBorder: const UnderlineInputBorder(
              borderSide: BorderSide(color: AppColors.error, width: 2),
            ),
          ),
        ),
        if (error != null) ...[
          const SizedBox(height: 6),
          Text(error, style: AppTextStyles.bodySmall(color: AppColors.error)),
        ],
      ],
    );
  }
}

