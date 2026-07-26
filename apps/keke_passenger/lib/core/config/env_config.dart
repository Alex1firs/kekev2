enum AppEnvironment { dev, staging, prod }

class EnvConfig {
  final AppEnvironment environment;
  final String apiBaseUrl;
  final String googleMapsApiKey;

  /// Support line offered when a ride is escalated to a human. Empty means the
  /// app shows the escalation state without a dial action rather than dialling
  /// a placeholder number.
  final String supportPhone;

  const EnvConfig({
    required this.environment,
    required this.apiBaseUrl,
    required this.googleMapsApiKey,
    this.supportPhone = '',
  });

  /// The active environment variables configured dynamically at compile/build time
  static EnvConfig get current {
    const String envString = String.fromEnvironment('ENV', defaultValue: 'dev');
    const String apiUrl = String.fromEnvironment('API_URL');
    
    const String mapsKey = String.fromEnvironment('GOOGLE_MAPS_API_KEY');
    if (mapsKey.isEmpty) {
      print(
        'WARNING: GOOGLE_MAPS_API_KEY is not set. '
        'Build with --dart-define=GOOGLE_MAPS_API_KEY=<your_key>',
      );
    }
    
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
      googleMapsApiKey: mapsKey, // Injected explicitly
      supportPhone: const String.fromEnvironment('SUPPORT_PHONE'),
    );
  }
}

