import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:google_fonts/google_fonts.dart';

class AppColors {
  // Primary — warm amber, keke identity
  static const Color primary       = Color(0xFFF59E0B);
  static const Color primaryDark   = Color(0xFFD97706);
  static const Color primaryLight  = Color(0xFFFEF3C7);

  // Neutrals
  static const Color charcoal      = Color(0xFF111827);
  static const Color darkGray      = Color(0xFF374151);
  static const Color midGray       = Color(0xFF6B7280);
  static const Color lightGray     = Color(0xFF9CA3AF);
  static const Color paleGray      = Color(0xFFF3F4F6);
  static const Color snow          = Color(0xFFFAFAFA);
  static const Color white         = Color(0xFFFFFFFF);

  // Semantic
  static const Color success       = Color(0xFF059669);
  static const Color successLight  = Color(0xFFD1FAE5);
  static const Color error         = Color(0xFFDC2626);
  static const Color errorLight    = Color(0xFFFEE2E2);
  static const Color warning       = Color(0xFFD97706);
  static const Color warningLight  = Color(0xFFFEF3C7);

  // Surfaces
  static const Color surface       = Color(0xFFFFFFFF);
  static const Color surfaceVariant = Color(0xFFF9FAFB);
  static const Color border        = Color(0xFFE5E7EB);
}

class AppTextStyles {
  static TextStyle get _base => GoogleFonts.plusJakartaSans();

  static TextStyle display({Color? color, FontWeight? weight}) =>
      _base.copyWith(fontSize: 32, fontWeight: weight ?? FontWeight.bold, color: color ?? AppColors.charcoal, height: 1.2);

  static TextStyle headline({Color? color, FontWeight? weight}) =>
      _base.copyWith(fontSize: 22, fontWeight: weight ?? FontWeight.bold, color: color ?? AppColors.charcoal, height: 1.3);

  static TextStyle title({Color? color, FontWeight? weight}) =>
      _base.copyWith(fontSize: 18, fontWeight: weight ?? FontWeight.w600, color: color ?? AppColors.charcoal, height: 1.4);

  static TextStyle body({Color? color, FontWeight? weight}) =>
      _base.copyWith(fontSize: 15, fontWeight: weight ?? FontWeight.normal, color: color ?? AppColors.charcoal, height: 1.5);

  static TextStyle bodySmall({Color? color, FontWeight? weight}) =>
      _base.copyWith(fontSize: 13, fontWeight: weight ?? FontWeight.normal, color: color ?? AppColors.midGray, height: 1.5);

  static TextStyle label({Color? color, FontWeight? weight}) =>
      _base.copyWith(fontSize: 12, fontWeight: weight ?? FontWeight.w500, color: color ?? AppColors.midGray, height: 1.4, letterSpacing: 0.2);

  static TextStyle caption({Color? color, FontWeight? weight}) =>
      _base.copyWith(fontSize: 11, fontWeight: weight ?? FontWeight.normal, color: color ?? AppColors.lightGray, height: 1.4);

  static TextStyle button({Color? color}) =>
      _base.copyWith(fontSize: 15, fontWeight: FontWeight.w700, color: color ?? AppColors.charcoal, letterSpacing: 0.3);

  static TextStyle mono({Color? color, double? size}) =>
      _base.copyWith(fontSize: size ?? 16, fontWeight: FontWeight.bold, color: color ?? AppColors.charcoal, letterSpacing: -0.5);
}

class AppTheme {
  static const Color primaryColor     = AppColors.primary;
  static const Color secondaryColor   = AppColors.charcoal;
  static const Color errorColor       = AppColors.error;
  static const Color textPrimaryColor = AppColors.charcoal;
  static const Color backgroundLight  = AppColors.snow;

  static ThemeData get lightTheme {
    final base = GoogleFonts.plusJakartaSansTextTheme();

    return ThemeData(
      useMaterial3: true,
      colorScheme: ColorScheme(
        brightness: Brightness.light,
        primary: AppColors.primary,
        onPrimary: AppColors.charcoal,
        primaryContainer: AppColors.primaryLight,
        onPrimaryContainer: AppColors.primaryDark,
        secondary: AppColors.charcoal,
        onSecondary: AppColors.white,
        secondaryContainer: AppColors.paleGray,
        onSecondaryContainer: AppColors.charcoal,
        error: AppColors.error,
        onError: AppColors.white,
        errorContainer: AppColors.errorLight,
        onErrorContainer: AppColors.error,
        surface: AppColors.surface,
        onSurface: AppColors.charcoal,
        surfaceContainerHighest: AppColors.paleGray,
        outline: AppColors.border,
        outlineVariant: AppColors.paleGray,
      ),
      scaffoldBackgroundColor: AppColors.snow,
      textTheme: base.copyWith(
        displayLarge: base.displayLarge?.copyWith(fontFamily: GoogleFonts.plusJakartaSans().fontFamily, color: AppColors.charcoal),
        displayMedium: base.displayMedium?.copyWith(fontFamily: GoogleFonts.plusJakartaSans().fontFamily, color: AppColors.charcoal),
        displaySmall: base.displaySmall?.copyWith(fontFamily: GoogleFonts.plusJakartaSans().fontFamily, color: AppColors.charcoal),
        headlineLarge: base.headlineLarge?.copyWith(fontFamily: GoogleFonts.plusJakartaSans().fontFamily, color: AppColors.charcoal, fontWeight: FontWeight.bold),
        headlineMedium: base.headlineMedium?.copyWith(fontFamily: GoogleFonts.plusJakartaSans().fontFamily, color: AppColors.charcoal, fontWeight: FontWeight.bold),
        headlineSmall: base.headlineSmall?.copyWith(fontFamily: GoogleFonts.plusJakartaSans().fontFamily, color: AppColors.charcoal, fontWeight: FontWeight.w600),
        titleLarge: base.titleLarge?.copyWith(fontFamily: GoogleFonts.plusJakartaSans().fontFamily, color: AppColors.charcoal, fontWeight: FontWeight.w600),
        titleMedium: base.titleMedium?.copyWith(fontFamily: GoogleFonts.plusJakartaSans().fontFamily, color: AppColors.charcoal, fontWeight: FontWeight.w600),
        titleSmall: base.titleSmall?.copyWith(fontFamily: GoogleFonts.plusJakartaSans().fontFamily, color: AppColors.charcoal, fontWeight: FontWeight.w500),
        bodyLarge: base.bodyLarge?.copyWith(fontFamily: GoogleFonts.plusJakartaSans().fontFamily, color: AppColors.charcoal),
        bodyMedium: base.bodyMedium?.copyWith(fontFamily: GoogleFonts.plusJakartaSans().fontFamily, color: AppColors.darkGray),
        bodySmall: base.bodySmall?.copyWith(fontFamily: GoogleFonts.plusJakartaSans().fontFamily, color: AppColors.midGray),
        labelLarge: base.labelLarge?.copyWith(fontFamily: GoogleFonts.plusJakartaSans().fontFamily, fontWeight: FontWeight.w700, letterSpacing: 0.3),
        labelMedium: base.labelMedium?.copyWith(fontFamily: GoogleFonts.plusJakartaSans().fontFamily, fontWeight: FontWeight.w600),
        labelSmall: base.labelSmall?.copyWith(fontFamily: GoogleFonts.plusJakartaSans().fontFamily, fontWeight: FontWeight.w500, letterSpacing: 0.2),
      ),
      appBarTheme: AppBarTheme(
        backgroundColor: AppColors.white,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 1,
        shadowColor: AppColors.border,
        centerTitle: false,
        iconTheme: const IconThemeData(color: AppColors.charcoal),
        actionsIconTheme: const IconThemeData(color: AppColors.charcoal),
        titleTextStyle: GoogleFonts.plusJakartaSans(
          fontSize: 18,
          fontWeight: FontWeight.w700,
          color: AppColors.charcoal,
        ),
        systemOverlayStyle: const SystemUiOverlayStyle(
          statusBarColor: Colors.transparent,
          statusBarIconBrightness: Brightness.dark,
        ),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: AppColors.primary,
          foregroundColor: AppColors.charcoal,
          disabledBackgroundColor: AppColors.paleGray,
          disabledForegroundColor: AppColors.lightGray,
          minimumSize: const Size(double.infinity, 52),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
          elevation: 0,
          textStyle: GoogleFonts.plusJakartaSans(fontSize: 15, fontWeight: FontWeight.w700, letterSpacing: 0.3),
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: AppColors.charcoal,
          minimumSize: const Size(double.infinity, 52),
          side: const BorderSide(color: AppColors.border, width: 1.5),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
          textStyle: GoogleFonts.plusJakartaSans(fontSize: 15, fontWeight: FontWeight.w600),
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: AppColors.primaryDark,
          textStyle: GoogleFonts.plusJakartaSans(fontSize: 14, fontWeight: FontWeight.w600),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: AppColors.surfaceVariant,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: AppColors.border, width: 1),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: AppColors.border, width: 1),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: AppColors.primary, width: 2),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: AppColors.error, width: 1),
        ),
        focusedErrorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: AppColors.error, width: 2),
        ),
        labelStyle: GoogleFonts.plusJakartaSans(fontSize: 14, color: AppColors.midGray),
        hintStyle: GoogleFonts.plusJakartaSans(fontSize: 14, color: AppColors.lightGray),
        errorStyle: GoogleFonts.plusJakartaSans(fontSize: 12, color: AppColors.error),
        prefixIconColor: AppColors.midGray,
        suffixIconColor: AppColors.midGray,
      ),
      cardTheme: CardThemeData(
        elevation: 0,
        color: AppColors.white,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: const BorderSide(color: AppColors.border, width: 1),
        ),
        margin: EdgeInsets.zero,
      ),
      chipTheme: ChipThemeData(
        backgroundColor: AppColors.paleGray,
        labelStyle: GoogleFonts.plusJakartaSans(fontSize: 12, fontWeight: FontWeight.w600),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      ),
      dividerTheme: const DividerThemeData(
        color: AppColors.border,
        thickness: 1,
        space: 1,
      ),
      listTileTheme: ListTileThemeData(
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
        titleTextStyle: GoogleFonts.plusJakartaSans(fontSize: 15, fontWeight: FontWeight.w600, color: AppColors.charcoal),
        subtitleTextStyle: GoogleFonts.plusJakartaSans(fontSize: 12, color: AppColors.midGray),
        iconColor: AppColors.midGray,
        minLeadingWidth: 24,
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        contentTextStyle: GoogleFonts.plusJakartaSans(fontSize: 14, fontWeight: FontWeight.w500),
      ),
      bottomSheetTheme: const BottomSheetThemeData(
        backgroundColor: AppColors.white,
        modalBackgroundColor: AppColors.white,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
        ),
        clipBehavior: Clip.antiAlias,
      ),
      progressIndicatorTheme: const ProgressIndicatorThemeData(
        color: AppColors.primary,
      ),
      floatingActionButtonTheme: FloatingActionButtonThemeData(
        backgroundColor: AppColors.primary,
        foregroundColor: AppColors.charcoal,
        elevation: 4,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      ),
    );
  }

  static ThemeData get darkTheme {
    return ThemeData(
      useMaterial3: true,
      colorScheme: ColorScheme.fromSeed(seedColor: AppColors.primary, brightness: Brightness.dark),
      textTheme: GoogleFonts.plusJakartaSansTextTheme(ThemeData(brightness: Brightness.dark).textTheme),
    );
  }
}
