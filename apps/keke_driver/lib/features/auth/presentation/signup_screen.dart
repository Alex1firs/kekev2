import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import '../application/auth_controller.dart';
import '../domain/auth_state.dart';
import '../../../core/theme/app_theme.dart';
import 'auth_widgets.dart';

class SignupScreen extends ConsumerStatefulWidget {
  const SignupScreen({super.key});

  @override
  ConsumerState<SignupScreen> createState() => _SignupScreenState();
}

class _SignupScreenState extends ConsumerState<SignupScreen> {
  final _pageController = PageController();
  int _step = 0;

  final _firstNameCtrl = TextEditingController();
  final _lastNameCtrl = TextEditingController();
  final _emailCtrl = TextEditingController();
  final _phoneCtrl = TextEditingController();
  final _passwordCtrl = TextEditingController();
  final _confirmCtrl = TextEditingController();

  final _firstNameFocus = FocusNode();
  final _lastNameFocus = FocusNode();
  final _emailFocus = FocusNode();
  final _phoneFocus = FocusNode();
  final _passwordFocus = FocusNode();
  final _confirmFocus = FocusNode();

  bool _obscurePassword = true;
  bool _obscureConfirm = true;

  final List<String?> _errors = List.filled(6, null);

  static const _totalSteps = 6;

  static const _questions = [
    'Let\'s get you\nearning! First\nname?',
    'Great! And\nyour last\nname?',
    'Your email\naddress?',
    'Your Nigerian\nphone number?',
    'Create a\nstrong password.',
    'Confirm your\npassword.',
  ];

  List<FocusNode> get _focusNodes => [
    _firstNameFocus, _lastNameFocus, _emailFocus,
    _phoneFocus, _passwordFocus, _confirmFocus,
  ];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _firstNameFocus.requestFocus());
  }

  @override
  void dispose() {
    _pageController.dispose();
    for (final c in [_firstNameCtrl, _lastNameCtrl, _emailCtrl, _phoneCtrl, _passwordCtrl, _confirmCtrl]) {
      c.dispose();
    }
    for (final f in _focusNodes) f.dispose();
    super.dispose();
  }

  bool _validateStep() {
    String? err;
    switch (_step) {
      case 0:
        final v = _firstNameCtrl.text.trim();
        if (v.isEmpty) err = 'First name is required';
        else if (v.length < 2) err = 'At least 2 characters';
      case 1:
        final v = _lastNameCtrl.text.trim();
        if (v.isEmpty) err = 'Last name is required';
        else if (v.length < 2) err = 'At least 2 characters';
      case 2:
        final v = _emailCtrl.text.trim();
        if (v.isEmpty) err = 'Email is required';
        else if (!RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(v)) err = 'Enter a valid email';
      case 3:
        final v = _phoneCtrl.text.trim().replaceAll(RegExp(r'[\s\-()]'), '');
        if (v.isEmpty) err = 'Phone number is required';
        else if (!RegExp(r'^(\+?234|0)[789]\d{9}$').hasMatch(v)) err = 'Enter a valid Nigerian number';
      case 4:
        final v = _passwordCtrl.text;
        if (v.isEmpty) err = 'Password is required';
        else if (v.length < 8) err = 'At least 8 characters';
      case 5:
        final v = _confirmCtrl.text;
        if (v.isEmpty) err = 'Please confirm your password';
        else if (v != _passwordCtrl.text) err = 'Passwords do not match';
    }
    setState(() => _errors[_step] = err);
    return err == null;
  }

  void _next() {
    if (!_validateStep()) return;
    if (_step < _totalSteps - 1) {
      final nextStep = _step + 1;
      setState(() => _step = nextStep);
      _pageController.nextPage(
        duration: const Duration(milliseconds: 420),
        curve: Curves.easeInOutCubic,
      );
      Future.delayed(const Duration(milliseconds: 450), () {
        if (mounted) _focusNodes[nextStep].requestFocus();
      });
    } else {
      _submit();
    }
  }

  void _back() {
    if (_step > 0) {
      final prevStep = _step - 1;
      setState(() => _step = prevStep);
      _pageController.previousPage(
        duration: const Duration(milliseconds: 420),
        curve: Curves.easeInOutCubic,
      );
      Future.delayed(const Duration(milliseconds: 450), () {
        if (mounted) _focusNodes[prevStep].requestFocus();
      });
    } else {
      Navigator.of(context).pop();
    }
  }

  void _submit() {
    FocusScope.of(context).unfocus();
    ref.read(authControllerProvider.notifier).signup(
      _emailCtrl.text.trim().toLowerCase(),
      _passwordCtrl.text,
      _firstNameCtrl.text.trim(),
      _lastNameCtrl.text.trim(),
      _phoneCtrl.text.trim(),
    );
  }

  @override
  Widget build(BuildContext context) {
    final authState = ref.watch(authControllerProvider);
    final isBusy = authState.status == AuthStatus.authenticating ||
        authState.status == AuthStatus.transitioning;

    ref.listen(authControllerProvider, (_, next) {
      if (next.status == AuthStatus.needsEmailVerification && next.pendingEmail != null) {
        context.push('/verify-email', extra: {
          'email': next.pendingEmail!,
          'devOtp': next.devOtp,
        });
      }
    });

    return Scaffold(
      backgroundColor: AppColors.charcoal,
      body: SafeArea(
        child: Column(
          children: [
            AuthTopBar(step: _step, totalSteps: _totalSteps, onBack: _back),
            Expanded(
              child: PageView(
                controller: _pageController,
                physics: const NeverScrollableScrollPhysics(),
                children: [
                  AuthStepPage(
                    question: _questions[0],
                    child: _buildTextField(ctrl: _firstNameCtrl, focus: _firstNameFocus,
                        hint: 'e.g. Chidi', error: _errors[0],
                        capitalization: TextCapitalization.words),
                  ),
                  AuthStepPage(
                    question: _questions[1],
                    child: _buildTextField(ctrl: _lastNameCtrl, focus: _lastNameFocus,
                        hint: 'e.g. Okafor', error: _errors[1],
                        capitalization: TextCapitalization.words),
                  ),
                  AuthStepPage(
                    question: _questions[2],
                    child: _buildTextField(ctrl: _emailCtrl, focus: _emailFocus,
                        hint: 'you@example.com', error: _errors[2],
                        keyboardType: TextInputType.emailAddress),
                  ),
                  AuthStepPage(
                    question: _questions[3],
                    child: _buildTextField(ctrl: _phoneCtrl, focus: _phoneFocus,
                        hint: '08012345678', error: _errors[3],
                        keyboardType: TextInputType.phone),
                  ),
                  AuthStepPage(
                    question: _questions[4],
                    child: _buildTextField(ctrl: _passwordCtrl, focus: _passwordFocus,
                        hint: '••••••••', error: _errors[4],
                        obscure: _obscurePassword,
                        suffix: IconButton(
                          icon: Icon(_obscurePassword ? Icons.visibility_off_outlined : Icons.visibility_outlined,
                              color: AppColors.midGray),
                          onPressed: () => setState(() => _obscurePassword = !_obscurePassword),
                        )),
                  ),
                  AuthStepPage(
                    question: _questions[5],
                    child: _buildTextField(ctrl: _confirmCtrl, focus: _confirmFocus,
                        hint: '••••••••', error: _errors[5],
                        obscure: _obscureConfirm,
                        suffix: IconButton(
                          icon: Icon(_obscureConfirm ? Icons.visibility_off_outlined : Icons.visibility_outlined,
                              color: AppColors.midGray),
                          onPressed: () => setState(() => _obscureConfirm = !_obscureConfirm),
                        )),
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
              label: _step == _totalSteps - 1 ? 'Create Account' : 'Continue',
              isBusy: isBusy,
              onTap: _next,
              footerText: 'Already have an account?',
              footerLinkText: 'Sign in',
              onFooterTap: () => context.pop(),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildTextField({
    required TextEditingController ctrl,
    required FocusNode focus,
    required String hint,
    String? error,
    TextInputType keyboardType = TextInputType.text,
    TextCapitalization capitalization = TextCapitalization.none,
    bool obscure = false,
    Widget? suffix,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        TextField(
          controller: ctrl,
          focusNode: focus,
          keyboardType: keyboardType,
          textCapitalization: capitalization,
          obscureText: obscure,
          autocorrect: false,
          textInputAction: TextInputAction.next,
          style: GoogleFonts.plusJakartaSans(
            fontSize: 22,
            fontWeight: FontWeight.w600,
            color: AppColors.white,
          ),
          onSubmitted: (_) => _next(),
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
