enum AppEnvironment { dev, staging, prod }

class EnvConfig {
  final AppEnvironment environment;
  final String apiBaseUrl;

  const EnvConfig({
    required this.environment,
    required this.apiBaseUrl,
  });

  /// The active environment variables configured dynamically at compile/build time
  /// using `--dart-define=ENV=...` and `--dart-define=API_URL=...`.
  /// Hardcoded fallbacks are explicitly removed to prevent false routing assumptions.
  static EnvConfig get current {
    const String envString = String.fromEnvironment('ENV', defaultValue: 'dev');
    const String apiUrl = String.fromEnvironment('API_URL');
    
    // Hard fallback to DigitalOcean backend since Xcode strips --dart-define during direct Archive
    final String resolvedApiUrl = apiUrl.isEmpty ? 'https://api.kekeride.ng/api/v1' : apiUrl;

    AppEnvironment parsedEnv;
    switch (envString) {
      case 'prod':
        parsedEnv = AppEnvironment.prod;
        break;
      case 'staging':
        parsedEnv = AppEnvironment.staging;
        break;
      case 'dev':
      default:
        parsedEnv = AppEnvironment.dev;
        break;
    }
    
    return EnvConfig(
      environment: parsedEnv,
      apiBaseUrl: resolvedApiUrl,
    );
  }
}
