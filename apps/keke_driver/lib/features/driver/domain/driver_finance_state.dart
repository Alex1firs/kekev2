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
    final type = json['transactionType'] as String? ?? '';
    final amount = double.parse(json['amount'].toString());
    final description = json['metadata']?['description'] as String? ?? _descriptionForType(type, amount);
    return DriverHistoryEntry(
      id: json['id'],
      amount: amount,
      type: type,
      description: description,
      date: DateTime.parse(json['createdAt']),
    );
  }

  static String _descriptionForType(String type, double amount) {
    switch (type) {
      case 'topup':             return 'Wallet Top-up';
      case 'trip_payment':      return amount > 0 ? 'Trip Earning' : 'Trip Payment';
      case 'commission_charge': return 'Commission Charge';
      case 'commission_credit': return 'Commission Credit';
      case 'cash_received':     return 'Cash Ride Collection';
      case 'cash_externalized': return 'Cash Externalized';
      case 'debt_recovery':     return 'Debt Recovery';
      case 'payout':            return 'Payout Requested';
      case 'refund':            return 'Refund';
      default:                  return amount > 0 ? 'Credit' : 'Debit';
    }
  }
}
