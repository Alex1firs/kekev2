import 'package:audioplayers/audioplayers.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

class SoundService {
  AudioPlayer? _player;

  // Built on first use: constructing an AudioPlayer touches platform channels,
  // so doing it eagerly would drag the whole audio stack into anything that
  // merely holds a SoundService.
  AudioPlayer get _audio => _player ??= AudioPlayer();

  Future<void> playAlert() async {
    try {
      await _audio.stop();
      // 'keke_ring.wav' must be in assets/sounds/
      await _audio.play(AssetSource('sounds/keke_ring.wav'));
    } catch (e) {
      print('[SOUND_ERROR] Failed to play alert sound: $e');
    }
  }

  Future<void> dispose() async {
    await _player?.dispose();
  }
}

final soundServiceProvider = Provider<SoundService>((ref) {
  final service = SoundService();
  ref.onDispose(() => service.dispose());
  return service;
});
