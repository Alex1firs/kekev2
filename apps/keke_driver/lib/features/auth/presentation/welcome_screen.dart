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
      backgroundColor: AppColors.charcoal,
      body: Stack(
        children: [
          // Night city skyline background
          Positioned.fill(
            child: CustomPaint(painter: _NightSkylinePainter()),
          ),

          // Content
          Column(
            children: [
              // ── Branding ─────────────────────────────────────────────
              SizedBox(height: topPad + 24),
              Image.asset(
                'assets/images/app_logo.png',
                width: size.width * 0.30,
                height: size.width * 0.30,
                fit: BoxFit.contain,
              ),
              const SizedBox(height: 18),
              RichText(
                text: TextSpan(children: [
                  TextSpan(
                    text: 'Keke',
                    style: GoogleFonts.plusJakartaSans(
                      fontSize: 32,
                      fontWeight: FontWeight.w800,
                      color: AppColors.white,
                      letterSpacing: -0.5,
                    ),
                  ),
                  TextSpan(
                    text: 'Ride',
                    style: GoogleFonts.plusJakartaSans(
                      fontSize: 32,
                      fontWeight: FontWeight.w800,
                      color: AppColors.primary,
                      letterSpacing: -0.5,
                    ),
                  ),
                  TextSpan(
                    text: '.ng',
                    style: GoogleFonts.plusJakartaSans(
                      fontSize: 32,
                      fontWeight: FontWeight.w800,
                      color: AppColors.success,
                      letterSpacing: -0.5,
                    ),
                  ),
                ]),
              ),
              const SizedBox(height: 10),
              // Tagline with amber lines
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(width: 28, height: 1.5, color: AppColors.primary),
                  const SizedBox(width: 8),
                  Text(
                    'Drive. Earn. Grow.',
                    style: GoogleFonts.plusJakartaSans(
                      fontSize: 14,
                      fontWeight: FontWeight.w400,
                      color: AppColors.white,
                      letterSpacing: 0.4,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Container(width: 28, height: 1.5, color: AppColors.primary),
                ],
              ),
              const SizedBox(height: 6),
              Text(
                'DRIVER APP',
                style: GoogleFonts.plusJakartaSans(
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                  color: AppColors.success,
                  letterSpacing: 2.5,
                ),
              ),

              // ── Middle: features + keke ───────────────────────────────
              Expanded(
                child: Stack(
                  children: [
                    // Amber wave road at bottom
                    Positioned(
                      bottom: 0,
                      left: 0,
                      right: 0,
                      height: size.height * 0.22,
                      child: CustomPaint(painter: _AmberRoadPainter()),
                    ),

                    // Feature list — left column
                    Positioned(
                      left: 16,
                      top: 16,
                      width: size.width * 0.50,
                      bottom: size.height * 0.06,
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: const [
                          _FeatureItem(
                            icon: Icons.monetization_on_outlined,
                            title: 'More Earnings',
                            subtitle: 'Get more trips and\nincrease your income.',
                          ),
                          SizedBox(height: 16),
                          _FeatureItem(
                            icon: Icons.security_outlined,
                            title: "You're Protected",
                            subtitle: 'Insurance coverage and\n24/7 support.',
                          ),
                          SizedBox(height: 16),
                          _FeatureItem(
                            icon: Icons.access_time_outlined,
                            title: 'Flexible Hours',
                            subtitle: 'Work on your own time\nand at your pace.',
                          ),
                          SizedBox(height: 16),
                          _FeatureItem(
                            icon: Icons.bar_chart_rounded,
                            title: 'Track Performance',
                            subtitle: 'Monitor your stats and\ngrow with every trip.',
                          ),
                        ],
                      ),
                    ),

                    // Keke photo — right side, sitting on the wave
                    Positioned(
                      right: -8,
                      bottom: 0,
                      child: Image.asset(
                        'assets/images/keke_marker.jpg',
                        width: size.width * 0.56,
                        fit: BoxFit.contain,
                      ),
                    ),
                  ],
                ),
              ),

              // ── Buttons ───────────────────────────────────────────────
              Padding(
                padding: EdgeInsets.fromLTRB(20, 0, 20, bottomPad + 16),
                child: Column(
                  children: [
                    _GoOnlineButton(),
                    const SizedBox(height: 10),
                    _LoginButton(),
                    const SizedBox(height: 16),
                    RichText(
                      text: TextSpan(children: [
                        TextSpan(
                          text: "Let's drive together. Let's go ",
                          style: GoogleFonts.plusJakartaSans(
                            fontSize: 13,
                            color: AppColors.lightGray,
                          ),
                        ),
                        TextSpan(
                          text: 'further.',
                          style: GoogleFonts.plusJakartaSans(
                            fontSize: 13,
                            fontWeight: FontWeight.w600,
                            color: AppColors.primary,
                          ),
                        ),
                      ]),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

// ── Subwidgets ─────────────────────────────────────────────────────────────

class _FeatureItem extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;

  const _FeatureItem({
    required this.icon,
    required this.title,
    required this.subtitle,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: 38,
          height: 38,
          decoration: BoxDecoration(
            color: const Color(0xFF1F2937),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Icon(icon, color: AppColors.primary, size: 20),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: GoogleFonts.plusJakartaSans(
                  fontSize: 13,
                  fontWeight: FontWeight.w700,
                  color: AppColors.white,
                  height: 1.3,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                subtitle,
                style: GoogleFonts.plusJakartaSans(
                  fontSize: 11,
                  color: AppColors.midGray,
                  height: 1.4,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _GoOnlineButton extends StatelessWidget {
  const _GoOnlineButton();

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () => context.go('/signup'),
      child: Container(
        width: double.infinity,
        height: 56,
        decoration: BoxDecoration(
          color: AppColors.primary,
          borderRadius: BorderRadius.circular(32),
        ),
        child: Stack(
          alignment: Alignment.center,
          children: [
            Text(
              'Go Online',
              style: GoogleFonts.plusJakartaSans(
                fontSize: 17,
                fontWeight: FontWeight.w700,
                color: AppColors.charcoal,
                letterSpacing: 0.2,
              ),
            ),
            Positioned(
              right: 20,
              child: Icon(
                Icons.arrow_forward_rounded,
                color: AppColors.charcoal,
                size: 22,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _LoginButton extends StatelessWidget {
  const _LoginButton();

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () => context.go('/login'),
      child: Container(
        width: double.infinity,
        height: 56,
        decoration: BoxDecoration(
          color: const Color(0xFF1F2937),
          borderRadius: BorderRadius.circular(32),
          border: Border.all(color: const Color(0xFF374151), width: 1.5),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.person_outline_rounded, color: AppColors.primary, size: 20),
            const SizedBox(width: 8),
            Text(
              'Login',
              style: GoogleFonts.plusJakartaSans(
                fontSize: 17,
                fontWeight: FontWeight.w600,
                color: AppColors.primary,
                letterSpacing: 0.2,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ── Painters ───────────────────────────────────────────────────────────────

/// Dramatic night city skyline silhouette.
class _NightSkylinePainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = const Color(0xFFFFFFFF).withValues(alpha: 0.04)
      ..style = PaintingStyle.fill;

    // Building data: [leftFraction, topFraction, widthFraction]
    // (all buildings extend down to 90% of screen height)
    const buildings = [
      [0.00, 0.45, 0.05],
      [0.06, 0.32, 0.04],
      [0.11, 0.40, 0.06],
      [0.18, 0.24, 0.04],
      [0.23, 0.38, 0.07],
      [0.31, 0.28, 0.04],
      [0.36, 0.44, 0.05],
      [0.42, 0.20, 0.04],
      [0.47, 0.35, 0.06],
      [0.54, 0.42, 0.05],
      [0.60, 0.26, 0.04],
      [0.65, 0.38, 0.07],
      [0.73, 0.30, 0.05],
      [0.79, 0.45, 0.06],
      [0.86, 0.36, 0.04],
      [0.91, 0.48, 0.05],
      [0.96, 0.40, 0.04],
    ];

    const groundLine = 0.90;

    for (final b in buildings) {
      final rect = Rect.fromLTWH(
        b[0] * size.width,
        b[1] * size.height,
        b[2] * size.width,
        (groundLine - b[1]) * size.height,
      );
      canvas.drawRect(rect, paint);

      // Tower spire on tall buildings
      if (b[1] < 0.32) {
        canvas.drawRect(
          Rect.fromLTWH(
            (b[0] + b[2] * 0.35) * size.width,
            (b[1] - 0.07) * size.height,
            b[2] * 0.28 * size.width,
            0.07 * size.height,
          ),
          paint,
        );
      }
    }

    // Ground line
    canvas.drawRect(
      Rect.fromLTWH(0, groundLine * size.height, size.width, 2),
      paint,
    );
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// Amber road wave that fills the bottom of the content area —
/// the keke sits on top of this surface.
class _AmberRoadPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = AppColors.primary
      ..style = PaintingStyle.fill;

    final path = Path();
    // Start from bottom-left corner
    path.moveTo(0, size.height);
    // Rise to left wave point
    path.lineTo(0, size.height * 0.72);
    // Sweep up toward the right (road going into distance)
    path.cubicTo(
      size.width * 0.20, size.height * 0.30,
      size.width * 0.55, size.height * 0.18,
      size.width, size.height * 0.40,
    );
    // Right edge down to bottom
    path.lineTo(size.width, size.height);
    path.close();

    canvas.drawPath(path, paint);

    // Road centre marking (white dashed line on the amber surface)
    final linePaint = Paint()
      ..color = const Color(0xFFFFFFFF).withValues(alpha: 0.25)
      ..strokeWidth = 1.5
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round;

    final linePath = Path()
      ..moveTo(size.width * 0.06, size.height * 0.85)
      ..cubicTo(
        size.width * 0.20, size.height * 0.55,
        size.width * 0.42, size.height * 0.38,
        size.width * 0.72, size.height * 0.45,
      );
    canvas.drawPath(linePath, linePaint);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
