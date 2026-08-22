package ng.kekeride.driver

import android.app.NotificationChannel
import android.app.NotificationManager
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import android.os.Bundle
import io.flutter.embedding.android.FlutterActivity

private const val RIDE_CHANNEL_ID = "keke_ride_requests_v2"

class MainActivity : FlutterActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        createRideRequestChannel()
    }

    /**
     * On Android 8+ the notification sound is taken from the CHANNEL, not the
     * FCM message. Create a high-importance "Ride Requests" channel whose sound
     * is the bundled keke_ring so new-ride pushes play the ring (heads-up +
     * vibrate). FCM targets it via default_notification_channel_id in the
     * manifest and the channelId set on the message.
     */
    /**
     * Create the ride-request channel.
     *
     * ── Why the id is versioned ─────────────────────────────────────────
     * A NotificationChannel's importance and sound are fixed at creation and
     * can never be changed by code afterwards — only by the user. Worse, the
     * previous id could be created by any of three racing paths, and whichever
     * ran first on a given install won:
     *
     *   1. this native call,
     *   2. flutter_local_notifications in ride_notification_service, and
     *   3. Play Services itself, auto-creating the manifest's
     *      default_notification_channel_id when a notification arrived before
     *      the app had ever run — with DEFAULT importance and DEFAULT sound.
     *
     * Path 3 is silent under MIUI, and it is permanent. A Redmi in the field
     * displayed our ride-request notification without a sound for exactly this
     * reason; no code change to the old id could have fixed it, and deleting
     * and recreating does not help either, because Android restores a deleted
     * channel's old settings when an id is reused.
     *
     * A NEW id has never existed on any handset, so its properties are
     * whatever we set here. Bump the suffix if they ever need to change again.
     */
    private fun createRideRequestChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val soundUri = Uri.parse("android.resource://$packageName/raw/keke_ring")
            val attrs = AudioAttributes.Builder()
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .build()
            val channel = NotificationChannel(
                RIDE_CHANNEL_ID,
                "Ride Requests",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Alerts for new ride requests"
                setSound(soundUri, attrs)
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 400, 200, 400)
                enableLights(true)
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager?.createNotificationChannel(channel)
            // Retire the old one so it stops appearing in the driver's
            // notification settings as a second, silent "Ride Requests".
            runCatching { manager?.deleteNotificationChannel("keke_ride_requests") }
        }
    }
}
