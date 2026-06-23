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
    bool clearErrorMessage = false,
  }) {
    return WalletState(
      balance: balance ?? this.balance,
      history: history ?? this.history,
      isLoading: isLoading ?? this.isLoading,
      errorMessage: clearErrorMessage ? null : (errorMessage ?? this.errorMessage),
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
  final Map<String, dynamic>? metadata;

  WalletTransaction({
    required this.id,
    required this.amount,
    required this.type,
    required this.description,
    required this.date,
    required this.balanceAfter,
    this.metadata,
  });

  factory WalletTransaction.fromJson(Map<String, dynamic> json) {
    final amount = double.tryParse(json['amount']?.toString() ?? '') ?? 0.0;
    final type   = json['transactionType']?.toString() ?? '';
    final description = json['metadata']?['description']?.toString() ??
        _descriptionForType(type, amount);
    final metadataMap = json['metadata'] is Map<String, dynamic>
        ? json['metadata'] as Map<String, dynamic>
        : null;
    return WalletTransaction(
      id: json['id']?.toString() ?? '',
      amount: amount,
      type: type,
      description: description,
      date: DateTime.tryParse(json['createdAt']?.toString() ?? '') ?? DateTime.now(),
      balanceAfter: double.tryParse(json['balanceAfter']?.toString() ?? '') ?? 0.0,
      metadata: metadataMap,
    );
  }

  static String _descriptionForType(String type, double amount) {
    switch (type) {
      case 'topup':        return 'Wallet Top-up';
      case 'trip_payment': return amount < 0 ? 'Ride Payment' : 'Refund';
      case 'refund':       return 'Refund';
      default:             return amount > 0 ? 'Credit' : 'Debit';
    }
  }
}
