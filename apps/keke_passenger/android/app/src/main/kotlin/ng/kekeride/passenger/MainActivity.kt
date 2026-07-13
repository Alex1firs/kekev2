package ng.kekeride.passenger

import android.app.NotificationChannel
import android.app.NotificationManager
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import android.os.Bundle
import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        createNotificationChannels()
    }

    /**
     * On Android 8+ the notification sound is taken from the CHANNEL, not the
     * FCM message. Create two channels:
     *  - "keke_ride_updates": high-importance, plays the bundled keke_ring for
     *    the moments the passenger must not miss (driver assigned / arrived).
     *    The backend targets it via the channelId on those messages.
     *  - "keke_general": default channel (default sound) for everything else
     *    (trip completed, payment held, cancellations). Declared as the app's
     *    default_notification_channel_id in the manifest so those pushes don't
     *    ring the loud alert tone.
     */
    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java) ?: return

            val soundUri = Uri.parse("android.resource://$packageName/raw/keke_ring")
            val attrs = AudioAttributes.Builder()
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .build()
            val rideUpdates = NotificationChannel(
                "keke_ride_updates",
                "Ride Updates",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Alerts when your driver is assigned or has arrived"
                setSound(soundUri, attrs)
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 400, 200, 400)
                enableLights(true)
            }
            manager.createNotificationChannel(rideUpdates)

            val general = NotificationChannel(
                "keke_general",
                "General",
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = "Trip receipts and other updates"
            }
            manager.createNotificationChannel(general)
        }
    }
}
