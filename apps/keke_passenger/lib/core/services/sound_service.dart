import 'package:audioplayers/audioplayers.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

class SoundService {
  final AudioPlayer _player = AudioPlayer();

  Future<void> playAlert() async {
    try {
      await _player.stop();
      // 'keke_ring.wav' must be in assets/sounds/
      await _player.play(AssetSource('sounds/keke_ring.wav'));
    } catch (e) {
      print('[SOUND_ERROR] Failed to play alert sound: $e');
    }
  }

  Future<void> dispose() {
    return _player.dispose();
  }
}

final soundServiceProvider = Provider<SoundService>((ref) {
  final service = SoundService();
  ref.onDispose(() => service.dispose());
  return service;
});
