class DriverFinanceState {
  final double availableBalance;
  final double pendingBalance;
  final double commissionDebt;
  final List<DriverHistoryEntry> history;
  final bool isLoading;
  final String? errorMessage;

  DriverFinanceState({
    this.availableBalance = 0.0,
    this.pendingBalance = 0.0,
    this.commissionDebt = 0.0,
    this.history = const [],
    this.isLoading = false,
    this.errorMessage,
  });

  DriverFinanceState copyWith({
    double? availableBalance,
    double? pendingBalance,
    double? commissionDebt,
    List<DriverHistoryEntry>? history,
    bool? isLoading,
    String? errorMessage,
  }) {
    return DriverFinanceState(
      availableBalance: availableBalance ?? this.availableBalance,
      pendingBalance: pendingBalance ?? this.pendingBalance,
      commissionDebt: commissionDebt ?? this.commissionDebt,
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

  DriverHistoryEntry({
    required this.id,
    required this.amount,
    required this.type,
    required this.description,
    required this.date,
  });

  factory DriverHistoryEntry.fromJson(Map<String, dynamic> json) {
    return DriverHistoryEntry(
      id: json['id'],
      amount: double.parse(json['amount'].toString()),
      type: json['transactionType'],
      description: json['metadata']?['description'] ?? (json['amount'] > 0 ? 'Trip Earning' : 'Commission Charge'),
      date: DateTime.parse(json['createdAt']),
    );
  }
}
