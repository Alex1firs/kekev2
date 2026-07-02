enum DriverStatus {
  unregistered,
  pendingDocuments,
  pendingApproval,
  approved,
  suspended,
  rejected
}

enum OperationStatus {
  offline,
  available,
  busy
}

enum TripStep {
  none,
  accepted,
  arrived,
  started,
  completed
}

class DriverProfile {
  final String? id;
  final String? firstName;
  final String? lastName;
  final DriverStatus status;
  final String? vehiclePlate;
  final String? vehicleModel;
  final String? licenseUrl;
  final String? idCardUrl;
  final String? vehiclePaperUrl;
  final String? photoUrl;
  final double debtAmount;
  final bool ninVerified;

  const DriverProfile({
    this.id,
    this.firstName,
    this.lastName,
    required this.status,
    this.vehiclePlate,
    this.vehicleModel,
    this.licenseUrl,
    this.idCardUrl,
    this.vehiclePaperUrl,
    this.photoUrl,
    this.debtAmount = 0.0,
    this.ninVerified = false,
  });

  DriverProfile copyWith({
    String? id,
    String? firstName,
    String? lastName,
    DriverStatus? status,
    String? vehiclePlate,
    String? vehicleModel,
    String? licenseUrl,
    String? idCardUrl,
    String? vehiclePaperUrl,
    String? photoUrl,
    double? debtAmount,
    bool? ninVerified,
  }) {
    return DriverProfile(
      id: id ?? this.id,
      firstName: firstName ?? this.firstName,
      lastName: lastName ?? this.lastName,
      status: status ?? this.status,
      vehiclePlate: vehiclePlate ?? this.vehiclePlate,
      vehicleModel: vehicleModel ?? this.vehicleModel,
      licenseUrl: licenseUrl ?? this.licenseUrl,
      idCardUrl: idCardUrl ?? this.idCardUrl,
      vehiclePaperUrl: vehiclePaperUrl ?? this.vehiclePaperUrl,
      photoUrl: photoUrl ?? this.photoUrl,
      debtAmount: debtAmount ?? this.debtAmount,
      ninVerified: ninVerified ?? this.ninVerified,
    );
  }
}
