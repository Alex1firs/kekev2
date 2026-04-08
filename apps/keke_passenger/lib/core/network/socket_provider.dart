import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../features/auth/application/auth_controller.dart';
import 'socket_service.dart';

final socketServiceProvider = Provider<SocketService?>((ref) {
  final authState = ref.watch(authControllerProvider);
  
  if (authState.status != AuthStatus.authenticated || authState.user == null) {
    return null;
  }
  
  final service = SocketService('passenger', authState.user!.id);
  ref.onDispose(() => service.dispose());
  return service;
});
