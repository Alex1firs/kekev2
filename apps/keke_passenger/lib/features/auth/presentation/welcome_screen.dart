import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import '../../../core/theme/app_theme.dart';

class WelcomeScreen extends StatelessWidget {
  const WelcomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.of(context).size;
    final topPad = MediaQuery.of(context).padding.top;
    final bottomPad = MediaQuery.of(context).padding.bottom;

    return Scaffold(
      backgroundColor: AppColors.snow,
      body: Column(
        children: [
          // ── Upper white section ──────────────────────────────────────
          Expanded(
            flex: 57,
            child: Stack(
              children: [
                Positioned.fill(child: CustomPaint(painter: _SkylinePainter())),
                Padding(
                  padding: EdgeInsets.only(top: topPad),
                  child: Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        // Logo
                        Image.asset(
                          'assets/images/app_logo.png',
                          width: size.width * 0.33,
                          height: size.width * 0.33,
                          fit: BoxFit.contain,
                        ),
                        const SizedBox(height: 22),
                        // Brand name
                        RichText(
                          text: TextSpan(children: [
                            TextSpan(
                              text: 'Keke',
                              style: GoogleFonts.plusJakartaSans(
                                fontSize: 34,
                                fontWeight: FontWeight.w800,
                                color: AppColors.charcoal,
                                letterSpacing: -0.5,
                              ),
                            ),
                            TextSpan(
                              text: 'Ride',
                              style: GoogleFonts.plusJakartaSans(
                                fontSize: 34,
                                fontWeight: FontWeight.w800,
                                color: AppColors.primary,
                                letterSpacing: -0.5,
                              ),
                            ),
                            TextSpan(
                              text: '.ng',
                              style: GoogleFonts.plusJakartaSans(
                                fontSize: 34,
                                fontWeight: FontWeight.w800,
                                color: AppColors.success,
                                letterSpacing: -0.5,
                              ),
                            ),
                          ]),
                        ),
                        const SizedBox(height: 10),
                        Text(
                          'Your Ride. Your Way.',
                          style: GoogleFonts.plusJakartaSans(
                            fontSize: 15,
                            fontWeight: FontWeight.w400,
                            color: AppColors.midGray,
                            letterSpacing: 0.3,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),

          // ── Lower amber section ──────────────────────────────────────
          Expanded(
            flex: 43,
            child: ClipPath(
              clipper: _WaveClipper(),
              child: Container(
                color: AppColors.primary,
                child: Stack(
                  children: [
                    // Road curve lines
                    Positioned.fill(
                      child: CustomPaint(painter: _RoadPainter()),
                    ),

                    // Keke photo — right side
                    Positioned(
                      right: -12,
                      bottom: bottomPad + 62,
                      child: Image.asset(
                        'assets/images/keke_marker.jpg',
                        width: size.width * 0.54,
                        fit: BoxFit.contain,
                      ),
                    ),

                    // Feature list — left side
                    Positioned(
                      left: 22,
                      top: 30,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: const [
                          _FeatureRow(
                            icon: Icons.verified_user_outlined,
                            label: 'Safe & Reliable',
                          ),
                          SizedBox(height: 13),
                          _FeatureRow(
                            icon: Icons.location_on_outlined,
                            label: 'Real-time Tracking',
                          ),
                          SizedBox(height: 13),
                          _FeatureRow(
                            icon: Icons.account_balance_wallet_outlined,
                            label: 'Cashless Payments',
                          ),
                          SizedBox(height: 13),
                          _FeatureRow(
                            icon: Icons.person_outline_rounded,
                            label: 'Verified Drivers',
                          ),
                        ],
                      ),
                    ),

                    // Get Started button
                    Positioned(
                      left: 20,
                      right: 20,
                      bottom: bottomPad + 16,
                      child: _GetStartedButton(),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ── Subwidgets ─────────────────────────────────────────────────────────────

class _FeatureRow extends StatelessWidget {
  final IconData icon;
  final String label;

  const _FeatureRow({required this.icon, required this.label});

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 38,
          height: 38,
          decoration: BoxDecoration(
            color: AppColors.primaryLight,
            borderRadius: BorderRadius.circular(10),
          ),
          child: Icon(icon, color: AppColors.charcoal, size: 20),
        ),
        const SizedBox(width: 12),
        Text(
          label,
          style: GoogleFonts.plusJakartaSans(
            fontSize: 14,
            fontWeight: FontWeight.w600,
            color: AppColors.charcoal,
          ),
        ),
      ],
    );
  }
}

class _GetStartedButton extends StatelessWidget {
  const _GetStartedButton();

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () => context.go('/login'),
      child: Container(
        height: 58,
        decoration: BoxDecoration(
          color: AppColors.charcoal,
          borderRadius: BorderRadius.circular(32),
        ),
        child: Stack(
          alignment: Alignment.center,
          children: [
            Text(
              'Get Started',
              style: GoogleFonts.plusJakartaSans(
                fontSize: 17,
                fontWeight: FontWeight.w700,
                color: AppColors.primary,
                letterSpacing: 0.2,
              ),
            ),
            Positioned(
              right: 20,
              child: Icon(
                Icons.arrow_forward_rounded,
                color: AppColors.primary,
                size: 22,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ── Painters ───────────────────────────────────────────────────────────────

/// Faint city-skyline silhouette behind the logo section.
class _SkylinePainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = const Color(0xFF000000).withOpacity(0.05)
      ..style = PaintingStyle.fill;

    // Building data: [leftFraction, topFraction, widthFraction, heightFraction]
    const buildings = [
      [0.02, 0.52, 0.06, 0.48],
      [0.09, 0.38, 0.04, 0.62],
      [0.14, 0.44, 0.07, 0.56],
      [0.22, 0.30, 0.05, 0.70],
      [0.28, 0.42, 0.06, 0.58],
      [0.35, 0.36, 0.04, 0.64],
      [0.40, 0.48, 0.08, 0.52],
      [0.49, 0.28, 0.05, 0.72],
      [0.55, 0.40, 0.07, 0.60],
      [0.63, 0.50, 0.06, 0.50],
      [0.70, 0.34, 0.05, 0.66],
      [0.76, 0.46, 0.07, 0.54],
      [0.84, 0.38, 0.05, 0.62],
      [0.90, 0.54, 0.06, 0.46],
    ];

    for (final b in buildings) {
      canvas.drawRect(
        Rect.fromLTWH(
          b[0] * size.width,
          b[1] * size.height,
          b[2] * size.width,
          b[3] * size.height,
        ),
        paint,
      );
      // Narrow tower on top of some buildings
      if (b[1] < 0.42) {
        canvas.drawRect(
          Rect.fromLTWH(
            (b[0] + b[2] * 0.35) * size.width,
            (b[1] - 0.08) * size.height,
            b[2] * 0.3 * size.width,
            0.08 * size.height,
          ),
          paint,
        );
      }
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// Two curved white lane lines sweeping from bottom-left toward upper-right.
class _RoadPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = Colors.white.withOpacity(0.55)
      ..strokeWidth = 2.8
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round;

    // Inner lane line
    final inner = Path()
      ..moveTo(size.width * 0.04, size.height * 1.0)
      ..cubicTo(
        size.width * 0.12, size.height * 0.65,
        size.width * 0.28, size.height * 0.30,
        size.width * 0.68, -size.height * 0.10,
      );
    canvas.drawPath(inner, paint);

    // Outer lane line
    final outer = Path()
      ..moveTo(size.width * 0.21, size.height * 1.0)
      ..cubicTo(
        size.width * 0.29, size.height * 0.65,
        size.width * 0.46, size.height * 0.30,
        size.width * 0.86, -size.height * 0.10,
      );
    canvas.drawPath(outer, paint);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// Gentle upward wave at the top of the amber section.
class _WaveClipper extends CustomClipper<Path> {
  @override
  Path getClip(Size size) {
    final path = Path();
    // Wave: starts at left edge a bit below the top,
    // arcs up to the top center, then back down on the right.
    path.moveTo(0, 26);
    path.quadraticBezierTo(size.width * 0.5, 0, size.width, 26);
    path.lineTo(size.width, size.height);
    path.lineTo(0, size.height);
    path.close();
    return path;
  }

  @override
  bool shouldReclip(covariant CustomClipper<Path> oldClipper) => false;
}
