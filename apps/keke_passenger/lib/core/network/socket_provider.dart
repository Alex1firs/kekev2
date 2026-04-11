import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../features/auth/application/auth_controller.dart';
import '../../features/auth/domain/auth_state.dart';
import 'socket_service.dart';
import 'package:jwt_decoder/jwt_decoder.dart';

final socketServiceProvider = Provider<SocketService?>((ref) {
  final authState = ref.watch(authControllerProvider);
  
  if (authState.status != AuthStatus.authenticated || authState.token == null) {
    return null;
  }
  
  // Extract userId from JWT
  final Map<String, dynamic> decodedToken = JwtDecoder.decode(authState.token!);
  final String? userId = decodedToken['userId'];
  
  if (userId == null) return null;
  
  final service = SocketService('passenger', userId);
  ref.onDispose(() => service.dispose());
  return service;
});
