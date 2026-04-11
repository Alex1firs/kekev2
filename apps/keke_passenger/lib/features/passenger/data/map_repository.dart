import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:dio/dio.dart';
import 'package:geocoding/geocoding.dart' as geocoder;
import 'package:geolocator/geolocator.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import '../../../core/config/env_config.dart';

class MapRepository {
  final Dio _dio;
  
  MapRepository(this._dio);

  Future<LatLng?> getCurrentLocation() async {
    bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
    if (!serviceEnabled) return null;

    LocationPermission permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
      if (permission == LocationPermission.denied) return null;
    }

    if (permission == LocationPermission.deniedForever) return null;

    try {
      final position = await Geolocator.getCurrentPosition(
        desiredAccuracy: LocationAccuracy.high,
        timeLimit: const Duration(seconds: 5),
      ).catchError((_) => Geolocator.getCurrentPosition(
        desiredAccuracy: LocationAccuracy.low,
        timeLimit: const Duration(seconds: 2),
      ));
      return LatLng(position.latitude, position.longitude);
    } catch (_) {
      final lastKnown = await Geolocator.getLastKnownPosition();
      return lastKnown != null ? LatLng(lastKnown.latitude, lastKnown.longitude) : null;
    }
  }

  Future<String?> reverseGeocode(LatLng target) async {
    try {
      final placemarks = await geocoder.placemarkFromCoordinates(
        target.latitude, 
        target.longitude
      ).timeout(const Duration(seconds: 3));
      if (placemarks.isNotEmpty) {
        final place = placemarks.first;
        final parts = [place.name, place.thoroughfare, place.subLocality].where((e) => e != null && e.isNotEmpty).toList();
        return parts.isEmpty ? 'Unknown Location' : parts.join(', ');
      }
    } catch (_) {
      // Gracefully handle OS decoder failures / limits
    }
    return 'Location selected';
  }

  final Options _mapHeaders = Options(headers: {
    'X-Ios-Bundle-Identifier': 'ng.kekeride.passenger',
    'X-Android-Package': 'ng.kekeride.passenger',
  });

  // Google Places Autocomplete API
  Future<List<Map<String, dynamic>>> getAutocompletePredictions(String query) async {
    if (query.isEmpty) return [];
    
    final apiKey = EnvConfig.current.googleMapsApiKey;
    final url = 'https://maps.googleapis.com/maps/api/place/autocomplete/json'
        '?input=$query'
        '&key=$apiKey'
        '&components=country:NG';

    try {
      final response = await _dio.get(url, options: _mapHeaders);
      if (response.data['status'] == 'OK') {
        final predictions = response.data['predictions'] as List;
        return predictions.map((p) => {
          'description': p['description'],
          'place_id': p['place_id'],
        }).toList();
      } else {
        print("Autocomplete Failed: \${response.data}");
      }
    } catch (e) {
      print("Autocomplete Exception: $e");
    }
    return [];
  }

  // Google Place Details to resolve coordinates
  Future<LatLng?> getPlaceDetails(String placeId) async {
    final apiKey = EnvConfig.current.googleMapsApiKey;
    final url = 'https://maps.googleapis.com/maps/api/place/details/json'
        '?place_id=$placeId'
        '&fields=geometry'
        '&key=$apiKey';

    try {
      final response = await _dio.get(url, options: _mapHeaders);
      if (response.data['status'] == 'OK') {
        final location = response.data['result']['geometry']['location'];
        return LatLng(location['lat'] as double, location['lng'] as double);
      } else {
        print("PlaceDetails Failed: \${response.data}");
      }
    } catch (e) {
       print("PlaceDetails Exception: $e");
    }
    return null;
  }

  // Real directions integration
  Future<Map<String, dynamic>> calculateRouteAndFare(LatLng origin, LatLng destination) async {
    final apiKey = EnvConfig.current.googleMapsApiKey;
    final url = 'https://maps.googleapis.com/maps/api/directions/json'
        '?origin=${origin.latitude},${origin.longitude}'
        '&destination=${destination.latitude},${destination.longitude}'
        '&key=$apiKey';

    final response = await _dio.get(url, options: _mapHeaders);
    if (response.data['status'] == 'OK') {
      final route = response.data['routes'][0];
      final leg = route['legs'][0];
      
      final distanceInMeters = leg['distance']['value'] as int;
      final distanceText = leg['distance']['text'] as String;
      final timeText = leg['duration']['text'] as String;
      final polylineEncoded = route['overview_polyline']['points'] as String;

      final int baseFare = 200; 
      final int perKm = 50; 
      final int totalFare = baseFare + ((distanceInMeters / 1000) * perKm).round();

      return {
        'distance': distanceText,
        'time': timeText,
        'fare': totalFare,
        'polyline': _decodePolyline(polylineEncoded),
      };
    }
    throw Exception('Failed to calculate route.');
  }

  List<LatLng> _decodePolyline(String encoded) {
    List<LatLng> polyline = [];
    int index = 0, len = encoded.length;
    int lat = 0, lng = 0;

    while (index < len) {
      int b, shift = 0, result = 0;
      do {
        b = encoded.codeUnitAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      int dlat = ((result & 1) != 0 ? ~(result >> 1) : (result >> 1));
      lat += dlat;

      shift = 0;
      result = 0;
      do {
        b = encoded.codeUnitAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      int dlng = ((result & 1) != 0 ? ~(result >> 1) : (result >> 1));
      lng += dlng;

      polyline.add(LatLng(lat / 1E5, lng / 1E5));
    }
    return polyline;
  }
}

final mapRepositoryProvider = Provider<MapRepository>((ref) {
  return MapRepository(Dio()); 
});
