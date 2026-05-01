import 'driver_profile.dart';
import 'trip_request.dart';
import 'chat_message.dart';

class DriverState {
  final DriverProfile profile;
  final OperationStatus operationStatus;
  final TripStep tripStep;
  final TripRequest? activeRequest;
  final int? countdown;
  final bool isLoading;
  final String? errorMessage;
  final int waitTimeSeconds;
  final List<ChatMessage> chatMessages;

  const DriverState({
    required this.profile,
    this.operationStatus = OperationStatus.offline,
    this.tripStep = TripStep.none,
    this.activeRequest,
    this.countdown,
    this.isLoading = false,
    this.errorMessage,
    this.waitTimeSeconds = 0,
    this.chatMessages = const [],
  });

  DriverState copyWith({
    DriverProfile? profile,
    OperationStatus? operationStatus,
    TripStep? tripStep,
    TripRequest? activeRequest,
    int? countdown,
    bool? isLoading,
    String? errorMessage,
    bool clearActiveRequest = false,
    bool clearCountdown = false,
    int? waitTimeSeconds,
    List<ChatMessage>? chatMessages,
  }) {
    return DriverState(
      profile: profile ?? this.profile,
      operationStatus: operationStatus ?? this.operationStatus,
      tripStep: tripStep ?? this.tripStep,
      activeRequest: clearActiveRequest ? null : (activeRequest ?? this.activeRequest),
      countdown: clearCountdown ? null : (countdown ?? this.countdown),
      isLoading: isLoading ?? this.isLoading,
      errorMessage: errorMessage ?? this.errorMessage,
      waitTimeSeconds: waitTimeSeconds ?? this.waitTimeSeconds,
      chatMessages: chatMessages ?? this.chatMessages,
    );
  }
}
