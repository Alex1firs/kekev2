import 'package:audioplayers/audioplayers.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

class SoundService {
  final AudioPlayer _player = AudioPlayer();

  Future<void> playRequestSound() async {
    try {
      await _player.stop();
      // Ring continuously (like an incoming call) until the driver accepts,
      // declines, or the request times out — SoundService.stop() ends it.
      await _player.setReleaseMode(ReleaseMode.loop);
      // 'keke_ring.wav' must be in assets/sounds/
      await _player.play(AssetSource('sounds/keke_ring.wav'));
    } catch (e) {
      print('[SOUND_ERROR] Failed to play request sound: $e');
    }
  }

  Future<void> stop() async {
    await _player.stop();
  }

  void dispose() {
    _player.dispose();
  }
}

final soundServiceProvider = Provider<SoundService>((ref) {
  final service = SoundService();
  ref.onDispose(() => service.dispose());
  return service;
});
