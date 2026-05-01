class ChatMessage {
  final String senderId;
  final String senderRole; // 'passenger' | 'driver'
  final String message;
  final DateTime timestamp;

  const ChatMessage({
    required this.senderId,
    required this.senderRole,
    required this.message,
    required this.timestamp,
  });

  bool get isPassenger => senderRole == 'passenger';
}
