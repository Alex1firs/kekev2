class WalletState {
  final double balance;
  final List<WalletTransaction> history;
  final bool isLoading;
  final String? errorMessage;

  WalletState({
    this.balance = 0.0,
    this.history = const [],
    this.isLoading = false,
    this.errorMessage,
  });

  WalletState copyWith({
    double? balance,
    List<WalletTransaction>? history,
    bool? isLoading,
    String? errorMessage,
  }) {
    return WalletState(
      balance: balance ?? this.balance,
      history: history ?? this.history,
      isLoading: isLoading ?? this.isLoading,
      errorMessage: errorMessage ?? this.errorMessage,
    );
  }
}

class WalletTransaction {
  final String id;
  final double amount;
  final String type;
  final String description;
  final DateTime date;
  final double balanceAfter;

  WalletTransaction({
    required this.id,
    required this.amount,
    required this.type,
    required this.description,
    required this.date,
    required this.balanceAfter,
  });

  factory WalletTransaction.fromJson(Map<String, dynamic> json) {
    return WalletTransaction(
      id: json['id'],
      amount: double.parse(json['amount'].toString()),
      type: json['transactionType'],
      description: json['metadata']?['description'] ?? (json['amount'] > 0 ? 'Top-up' : 'Ride Payment'),
      date: DateTime.parse(json['createdAt']),
      balanceAfter: double.parse(json['balanceAfter'].toString()),
    );
  }
}
