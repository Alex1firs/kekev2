import 'package:audioplayers/audioplayers.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

class SoundService {
  /// Constructed on first use, not at construction.
  ///
  /// `AudioPlayer()` reaches for a platform channel immediately, which throws
  /// under `flutter test` — so a test that only wants a silent subclass could not
  /// build one at all. Deferring it keeps the service constructible off-device.
  AudioPlayer? _player;
  AudioPlayer get _audio => _player ??= AudioPlayer();

  Future<void> playRequestSound() async {
    try {
      await _audio.stop();
      // Ring continuously (like an incoming call) until the driver accepts,
      // declines, or the request times out — SoundService.stop() ends it.
      await _audio.setReleaseMode(ReleaseMode.loop);
      // 'keke_ring.wav' must be in assets/sounds/
      await _audio.play(AssetSource('sounds/keke_ring.wav'));
    } catch (e) {
      print('[SOUND_ERROR] Failed to play request sound: $e');
    }
  }

  Future<void> stop() async {
    // Nothing was ever played, so there is nothing to stop.
    await _player?.stop();
  }

  void dispose() {
    _player?.dispose();
  }
}

final soundServiceProvider = Provider<SoundService>((ref) {
  final service = SoundService();
  ref.onDispose(() => service.dispose());
  return service;
});
