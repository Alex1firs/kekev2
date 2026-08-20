class DriverFinanceState {
  final double availableBalance;
  /// What the driver may actually take out: balance minus what they owe.
  ///
  /// Computed by the SERVER and carried here verbatim. The app must never
  /// derive it by subtracting debt itself — a client that gets that wrong
  /// shows money the driver cannot have, and they find out at the bank.
  final double withdrawable;
  final double pendingBalance;
  final double commissionDebt;
  final double totalCommissionPaid;
  final int totalTrips;
  final List<DriverHistoryEntry> history;
  final bool isLoading;
  final String? errorMessage;

  DriverFinanceState({
    this.availableBalance = 0.0,
    this.withdrawable = 0.0,
    this.pendingBalance = 0.0,
    this.commissionDebt = 0.0,
    this.totalCommissionPaid = 0.0,
    this.totalTrips = 0,
    this.history = const [],
    this.isLoading = false,
    this.errorMessage,
  });

  DriverFinanceState copyWith({
    double? availableBalance,
    double? withdrawable,
    double? pendingBalance,
    double? commissionDebt,
    double? totalCommissionPaid,
    int? totalTrips,
    List<DriverHistoryEntry>? history,
    bool? isLoading,
    String? errorMessage,
  }) {
    return DriverFinanceState(
      availableBalance: availableBalance ?? this.availableBalance,
      withdrawable: withdrawable ?? this.withdrawable,
      pendingBalance: pendingBalance ?? this.pendingBalance,
      commissionDebt: commissionDebt ?? this.commissionDebt,
      totalCommissionPaid: totalCommissionPaid ?? this.totalCommissionPaid,
      totalTrips: totalTrips ?? this.totalTrips,
      history: history ?? this.history,
      isLoading: isLoading ?? this.isLoading,
      errorMessage: errorMessage ?? this.errorMessage,
    );
  }

  double get totalEarnings => availableBalance + pendingBalance;
}

class DriverHistoryEntry {
  final String id;
  final double amount;
  final String type;
  final String description;
  final DateTime date;
  final Map<String, dynamic>? metadata;

  DriverHistoryEntry({
    required this.id,
    required this.amount,
    required this.type,
    required this.description,
    required this.date,
    this.metadata,
  });

  factory DriverHistoryEntry.fromJson(Map<String, dynamic> json) {
    final type = json['transactionType'] as String? ?? '';
    final amount = double.tryParse(json['amount']?.toString() ?? '') ?? 0.0;
    final description = json['metadata']?['description'] as String? ?? _descriptionForType(type, amount);
    final date = DateTime.tryParse(json['createdAt']?.toString() ?? '') ?? DateTime.now();
    final metadataMap = json['metadata'] is Map<String, dynamic>
        ? json['metadata'] as Map<String, dynamic>
        : null;
    return DriverHistoryEntry(
      id: json['id']?.toString() ?? '',
      amount: amount,
      type: type,
      description: description,
      date: date,
      metadata: metadataMap,
    );
  }

  static String _descriptionForType(String type, double amount) {
    switch (type) {
      case 'topup':             return 'Wallet Top-up';
      case 'trip_payment':      return amount > 0 ? 'Trip Earnings' : 'Trip Payment';
      case 'commission_charge': return 'Commission Charged';
      case 'commission_credit': return 'Commission Credit';
      case 'cash_received':     return 'Cash Payment Received';
      case 'cash_externalized': return 'Cash Transferred Out';
      case 'debt_recovery':     return 'Debt Recovery';
      case 'payout':            return 'Payout Requested';
      case 'refund':            return 'Refund';
      default:                  return amount > 0 ? 'Credit' : 'Debit';
    }
  }
}
