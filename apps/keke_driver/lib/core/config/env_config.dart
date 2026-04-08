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
    
    if (apiUrl.isEmpty) {
      throw Exception('CRITICAL: API_URL environment variable is missing. '
          'Please build using: flutter build <target> --dart-define=ENV=prod --dart-define=API_URL=https://<your-real-api-domain>');
    }

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
      apiBaseUrl: apiUrl,
    );
  }
}
