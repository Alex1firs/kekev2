# Keep classes that Android resolves BY NAME from the manifest or via reflection.
# If R8/shrinking is ever enabled for release, renaming these breaks the
# foreground service (the class no longer matches the <service> manifest entry),
# which silently kills background heartbeat/location. These keeps prevent that.

# flutter_foreground_task — the foreground service, receivers, and task handler.
-keep class com.pravera.flutter_foreground_task.** { *; }

# geolocator background location service.
-keep class com.baseflow.geolocator.** { *; }

# flutter_local_notifications (receivers/services referenced from manifest).
-keep class com.dexterous.** { *; }

# Firebase messaging services/receivers.
-keep class com.google.firebase.** { *; }
-keep class io.flutter.plugins.firebase.** { *; }

# Flutter embedding + plugin registrant.
-keep class io.flutter.** { *; }
-keep class io.flutter.plugins.** { *; }

# Keep @Keep-annotated members and Dart vm entry-points.
-keep @androidx.annotation.Keep class * { *; }
-keepclasseswithmembers class * {
    @androidx.annotation.Keep <methods>;
}
