import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

class SecureStorageService {
  final FlutterSecureStorage _storage;

  SecureStorageService(this._storage);

  Future<void> writeToken(String token) async {
    await _storage.write(key: 'session_token', value: token);
  }

  Future<String?> readToken() async {
    return await _storage.read(key: 'session_token');
  }

  Future<void> deleteToken() async {
    await _storage.delete(key: 'session_token');
  }

  Future<void> clearAll() async {
    await _storage.deleteAll();
  }
}

final flutterSecureStorageProvider = Provider<FlutterSecureStorage>((ref) {
  return const FlutterSecureStorage(
    iOptions: IOSOptions(accessibility: KeychainAccessibility.first_unlock),
  );
});

final secureStorageServiceProvider = Provider<SecureStorageService>((ref) {
  return SecureStorageService(ref.watch(flutterSecureStorageProvider));
});
