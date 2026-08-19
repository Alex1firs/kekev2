import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:dio/dio.dart';
import 'package:geocoding/geocoding.dart' as geocoder;
import 'package:geolocator/geolocator.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import '../../../core/config/env_config.dart';
import '../../../core/network/api_client.dart';
import '../domain/resolved_place.dart';

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
      return lastKnown != null
          ? LatLng(lastKnown.latitude, lastKnown.longitude)
          : null;
    }
  }

  /// Resolve a pin to a displayable address, keeping the structure.
  ///
  /// This used to return one joined string built from name/thoroughfare/
  /// subLocality and throw the rest of the Placemark away. The locality and
  /// state were already in hand and free — discarding them is what left
  /// operations unable to say which part of Onitsha a request came from.
  ///
  /// Never throws and never returns null: a failed geocode yields an
  /// unresolved place, because booking a Keke must not depend on Google
  /// answering. The coordinates are what the ride is actually built on.
  Future<ResolvedPlace> resolvePlace(LatLng target) async {
    try {
      final placemarks = await geocoder
          .placemarkFromCoordinates(target.latitude, target.longitude)
          .timeout(const Duration(seconds: 3));
      if (placemarks.isNotEmpty) {
        final place = placemarks.first;
        final parts = [place.name, place.thoroughfare, place.subLocality]
            .where((e) => e != null && e.isNotEmpty)
            .toList();

        // A plus code is what Google returns for `name` when a pin has no
        // street address. It is precise and meaningless to a human, so it is
        // dropped from the display line when anything else survives.
        final usable = parts.where((p) => !_isPlusCode(p!)).toList();
        final line = usable.isNotEmpty
            ? usable.join(', ')
            : (parts.isNotEmpty ? parts.join(', ') : 'Location selected');

        return ResolvedPlace(
          address: line,
          subLocality: place.subLocality,
          locality: place.locality,
          city: place.subAdministrativeArea?.isNotEmpty == true
              ? place.subAdministrativeArea
              : place.locality,
          state: place.administrativeArea,
        );
      }
    } catch (_) {
      // OS decoder failure, rate limit, or no network. Not an error the
      // passenger should ever see: they picked a point on a map and that is
      // all the ride needs.
    }
    return ResolvedPlace.unresolved();
  }

  /// An Open Location Code such as `4QHQ+3WF`.
  static bool _isPlusCode(String s) =>
      RegExp(r'^[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}$',
              caseSensitive: false)
          .hasMatch(s.trim());

  /// Back-compatible string form, for callers that only want the display line.
  Future<String?> reverseGeocode(LatLng target) async =>
      (await resolvePlace(target)).address;

  final Options _mapHeaders = Options(headers: {
    'X-Ios-Bundle-Identifier': 'ng.kekeride.passenger',
    'X-Android-Package': 'ng.kekeride.passenger',
  });

  // Google Places Autocomplete API
  Future<List<Map<String, dynamic>>> getAutocompletePredictions(
      String query) async {
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
        return predictions
            .map((p) => {
                  'description': p['description'],
                  'place_id': p['place_id'],
                })
            .toList();
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
  Future<Map<String, dynamic>> calculateRouteAndFare(
      LatLng origin, LatLng destination) async {
    double baseFare = 1300.0;
    double perKm = 300.0;
    double platformFeePercent = 10.0;

    try {
      final configResponse = await _dio.get('/rides/pricing-config');
      if (configResponse.statusCode == 200) {
        final config = configResponse.data;
        baseFare = (config['baseFare'] as num).toDouble();
        perKm = (config['perKmRate'] as num).toDouble();
        platformFeePercent = (config['platformFeePercent'] as num).toDouble();
      }
    } catch (e) {
      print("[Pricing] Failed to fetch dynamic pricing, using defaults: $e");
    }

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
      // Raw values were computed and thrown away; only the human strings were
      // kept. Support needs the numbers to reason about a trip after the fact.
      final durationInSeconds = (leg['duration']['value'] as num?)?.round();
      final polylineEncoded = route['overview_polyline']['points'] as String;

      final double distanceInKm = distanceInMeters / 1000.0;
      final double driverFare = baseFare + (distanceInKm * perKm);
      final double totalFare =
          driverFare * (1.0 + (platformFeePercent / 100.0));

      return {
        'distance': distanceText,
        'time': timeText,
        'fare': totalFare.round(),
        'polyline': _decodePolyline(polylineEncoded),
        'distanceMeters': distanceInMeters,
        'durationSeconds': durationInSeconds,
      };
    }
    throw Exception('Failed to calculate route.');
  }

  /// Fetches only the road-route polyline between two points (no fare calculation).
  Future<List<LatLng>> getRoutePath(LatLng origin, LatLng destination) async {
    final apiKey = EnvConfig.current.googleMapsApiKey;
    if (apiKey.isEmpty) return [];
    try {
      final url = 'https://maps.googleapis.com/maps/api/directions/json'
          '?origin=${origin.latitude},${origin.longitude}'
          '&destination=${destination.latitude},${destination.longitude}'
          '&key=$apiKey';
      final response = await _dio.get(url, options: _mapHeaders);
      if (response.data['status'] == 'OK') {
        final encoded =
            response.data['routes'][0]['overview_polyline']['points'] as String;
        return _decodePolyline(encoded);
      }
    } catch (_) {}
    return [];
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
  return MapRepository(ref.watch(dioProvider));
});
