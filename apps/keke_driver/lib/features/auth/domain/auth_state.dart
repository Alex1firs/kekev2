enum AuthStatus {
  initializing,
  unauthenticated,
  authenticating,
  transitioning,
  authenticated,
  error,
}

class AuthState {
  final AuthStatus status;
  final String? token;
  final String? errorMessage;

  const AuthState({
    required this.status,
    this.token,
    this.errorMessage,
  });

  factory AuthState.initializing() => const AuthState(status: AuthStatus.initializing);
  factory AuthState.unauthenticated() => const AuthState(status: AuthStatus.unauthenticated);
  factory AuthState.authenticating() => const AuthState(status: AuthStatus.authenticating);
  factory AuthState.transitioning(String token) => AuthState(status: AuthStatus.transitioning, token: token);
  factory AuthState.authenticated(String token) => AuthState(status: AuthStatus.authenticated, token: token);
  factory AuthState.error(String message) => AuthState(status: AuthStatus.error, errorMessage: message);

  AuthState copyWith({
    AuthStatus? status,
    String? token,
    String? errorMessage,
  }) {
    return AuthState(
      status: status ?? this.status,
      token: token ?? this.token,
      errorMessage: errorMessage, // Intentionally nullings if not provided
    );
  }
}
