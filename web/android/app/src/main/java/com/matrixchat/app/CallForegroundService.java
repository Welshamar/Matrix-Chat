package com.matrixchat.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

/**
 * Without this, Android aggressively suspends/throttles a backgrounded app's
 * JS and network activity -- which is where this app's WebRTC call actually
 * lives, since it's a plain WebView, not a native telephony stack. Switching
 * apps mid-call would stall or drop the media path within seconds. A
 * foreground service (with the required visible "ongoing call" notification)
 * is Android's sanctioned way to keep a process alive and unthrottled for
 * exactly this use case.
 */
public class CallForegroundService extends Service {
    public static final String EXTRA_VIDEO = "video";
    private static final String CHANNEL_ID = "call_ongoing";
    private static final int NOTIFICATION_ID = 4200;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        boolean video = intent != null && intent.getBooleanExtra(EXTRA_VIDEO, false);
        startForegroundCompat(video);
        return START_NOT_STICKY;
    }

    private void startForegroundCompat(boolean video) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Ongoing call", NotificationManager.IMPORTANCE_LOW);
            channel.setShowBadge(false);
            nm.createNotificationChannel(channel);
        }

        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, launchIntent, piFlags);

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Matrix Chat")
            .setContentText(video ? "Video call in progress" : "Voice call in progress")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();

        if (Build.VERSION.SDK_INT >= 34) { // Android 14 (UPSIDE_DOWN_CAKE): FGS type is mandatory at start time.
            int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE | (video ? ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA : 0);
            startForeground(NOTIFICATION_ID, notification, type);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
