/// A location the passenger picked, with whatever structure the geocoder gave us.
///
/// ── Why this exists ──────────────────────────────────────────────────────
/// The app used to flatten a `Placemark` into one string and send only that.
/// Operations then had to work out "which part of Onitsha was this?" from an
/// arbitrary address, and often could not: 211 of the first 824 production
/// pickups came through as a bare Google plus code (`4QHQ+3WF`), and geocoder
/// failures were sent as the literal text `Location selected`. Neither names a
/// place, so the operations console could only say "Area not recorded" — and
/// you cannot decide where to recruit drivers from that.
///
/// The structure was always there. `Placemark` carries `subLocality`,
/// `locality` and `administrativeArea`; the old code read three fields, joined
/// them, and discarded the rest. This keeps them.
///
/// ── What it is NOT ───────────────────────────────────────────────────────
/// Not a booking dependency. Every field except the coordinates is optional and
/// may be null. A geocoder that is slow, rate-limited, offline or simply has no
/// data for a spot must never stop a passenger booking a Keke — the ride is
/// requested on coordinates, which are captured from GPS and are always
/// present. Everything here is decoration on top of that.
class ResolvedPlace {
  const ResolvedPlace({
    required this.address,
    this.subLocality,
    this.locality,
    this.city,
    this.state,
  });

  /// Human-readable line shown to the passenger. Never null — falls back to a
  /// plain description rather than empty, because it is rendered directly.
  final String address;

  /// Neighbourhood — "Awada", "Upper Iweka". The most useful field for
  /// operations, and the one most often missing.
  final String? subLocality;

  /// Town/area — "Obosi", "Nkpor".
  final String? locality;

  /// City — "Onitsha".
  final String? city;

  /// State — "Anambra".
  final String? state;

  /// True when the geocoder gave us nothing usable and `address` is a
  /// placeholder. Kept explicit so the request can omit the address entirely
  /// rather than sending "Location selected" for the backend to store as if it
  /// were a place.
  bool get isPlaceholder => _placeholders.contains(address.trim().toLowerCase());

  static const _placeholders = {
    'location selected',
    'unknown location',
    'loading address...',
  };

  /// The area line for a UI that wants one: neighbourhood first, then town.
  /// Null when neither was resolved — the caller shows its own fallback rather
  /// than being handed an invented string.
  String? get areaLine {
    final parts = [subLocality, locality].where((p) => p != null && p.isNotEmpty).toList();
    return parts.isEmpty ? null : parts.join(', ');
  }

  /// Only the fields the geocoder actually produced. Absent keys are the
  /// honest signal that nothing was resolved; the backend stores null rather
  /// than an empty string, so reports can tell "not captured" from "captured
  /// as blank".
  Map<String, dynamic> toRequestFields(String prefix) => {
        if (!isPlaceholder) '${prefix}Address': address,
        if (subLocality?.isNotEmpty == true) '${prefix}SubLocality': subLocality,
        if (locality?.isNotEmpty == true) '${prefix}Locality': locality,
        if (city?.isNotEmpty == true) '${prefix}City': city,
        if (state?.isNotEmpty == true) '${prefix}State': state,
      };

  /// A place we could not resolve. `address` is still shown to the passenger.
  factory ResolvedPlace.unresolved([String label = 'Location selected']) =>
      ResolvedPlace(address: label);

  ResolvedPlace copyWith({String? address}) => ResolvedPlace(
        address: address ?? this.address,
        subLocality: subLocality,
        locality: locality,
        city: city,
        state: state,
      );

  @override
  String toString() => 'ResolvedPlace($address, area=$areaLine)';
}
