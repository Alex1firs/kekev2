import 'package:google_maps_flutter/google_maps_flutter.dart';

class SavedLocation {
  final String id;
  final String name;
  final String address;
  final LatLng location;

  SavedLocation({
    required this.id,
    required this.name,
    required this.address,
    required this.location,
  });

  factory SavedLocation.fromJson(Map<String, dynamic> json) {
    return SavedLocation(
      id: json['id'],
      name: json['name'],
      address: json['address'],
      location: LatLng(
        double.parse(json['lat'].toString()),
        double.parse(json['lng'].toString()),
      ),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'address': address,
      'lat': location.latitude,
      'lng': location.longitude,
    };
  }
}
