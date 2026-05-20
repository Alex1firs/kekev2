import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';

class WelcomeScreen extends StatefulWidget {
  const WelcomeScreen({super.key});

  @override
  State<WelcomeScreen> createState() => _WelcomeScreenState();
}

class _WelcomeScreenState extends State<WelcomeScreen> with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _scaleAnimation;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 2), // Smooth, slow pulse
    )..repeat(reverse: true); // Loop the animation back and forth

    _scaleAnimation = Tween<double>(begin: 1.0, end: 1.04).animate(
      CurvedAnimation(
        parent: _controller,
        curve: Curves.easeInOutSine, // Very smooth easing curve
      ),
    );
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      body: Stack(
        children: [
          // 1. The full-screen image provided by the user
          Positioned(
            top: -60,
            bottom: -110,
            left: 0,
            right: 0,
            child: Image.asset(
              'assets/images/splash_bg.png',
              fit: BoxFit.cover,
              alignment: Alignment.center,
            ),
          ),
          
          // 2. The functional animated Get Started button overlay
          Positioned(
            bottom: MediaQuery.of(context).padding.bottom + 16,
            left: 20,
            right: 20,
            child: ScaleTransition(
              scale: _scaleAnimation,
              child: SizedBox(
                height: 58,
                child: ElevatedButton(
                  onPressed: () => context.push('/login'),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF1E1E1E), // Dark charcoal
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(32),
                    ),
                    elevation: 10, // Added slight shadow to enhance the floating feel
                    shadowColor: const Color(0xFF1E1E1E).withOpacity(0.4),
                  ),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Text(
                        'Get Started',
                        style: GoogleFonts.plusJakartaSans(
                          fontSize: 17,
                          fontWeight: FontWeight.w700,
                          color: const Color(0xFFFFC500),
                          letterSpacing: 0.2,
                        ),
                      ),
                      const SizedBox(width: 8),
                      const Icon(
                        Icons.arrow_forward_rounded,
                        color: Color(0xFFFFC500),
                        size: 22,
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
