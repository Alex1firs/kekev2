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
  final double debtAmount;

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
    this.debtAmount = 0.0,
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
    double? debtAmount,
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
      debtAmount: debtAmount ?? this.debtAmount,
    );
  }
}
