import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../../core/network/api_client.dart';
import '../domain/saved_location.dart';

class PassengerRepository {
  final ApiClient _apiClient;

  PassengerRepository(this._apiClient);

  Future<List<SavedLocation>> getSavedLocations() async {
    try {
      final response = await _apiClient.dio.get('/passenger/saved-locations');
      final List data = response.data;
      return data.map((json) => SavedLocation.fromJson(json)).toList();
    } catch (e) {
      print('Error fetching saved locations: $e');
      rethrow;
    }
  }

  Future<SavedLocation> addSavedLocation({
    required String name,
    required String address,
    required double lat,
    required double lng,
  }) async {
    try {
      final response = await _apiClient.dio.post(
        '/passenger/saved-locations',
        data: {
          'name': name,
          'address': address,
          'lat': lat,
          'lng': lng,
        },
      );
      return SavedLocation.fromJson(response.data);
    } catch (e) {
      print('Error adding saved location: $e');
      rethrow;
    }
  }

  Future<void> deleteSavedLocation(String id) async {
    try {
      await _apiClient.dio.delete('/passenger/saved-locations/$id');
    } catch (e) {
      print('Error deleting saved location: $e');
      rethrow;
    }
  }
}

final passengerRepositoryProvider = Provider<PassengerRepository>((ref) {
  final apiClient = ref.watch(apiClientProvider);
  return PassengerRepository(apiClient);
});
