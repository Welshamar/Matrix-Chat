package com.matrixchat.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.WindowManager;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

/**
 * Bridges Android's native screen-capture API into the WebView's WebRTC call,
 * which otherwise has no way to share the screen at all -- a plain WebView
 * doesn't expose the getDisplayMedia() picker a real browser does (see
 * CallClient.canShareScreen for the desktop-web path this replaces). Frames
 * are JPEG-encoded and bridged to JS as base64 (see ScreenCapturePlugin),
 * which draws them onto a canvas whose captureStream() feeds the same
 * replaceTrack() swap the desktop path uses. Capped to ~7-8fps so that
 * bridge traffic (and the encode cost) stays reasonable -- visibly choppier
 * than a real screen share, fine for a document or slides, not fast motion.
 */
public class ScreenCaptureService extends Service {
    public static final String EXTRA_RESULT_CODE = "resultCode";
    public static final String EXTRA_RESULT_DATA = "resultData";
    private static final String CHANNEL_ID = "screen_share";
    private static final int NOTIFICATION_ID = 4300;
    private static final long MIN_FRAME_INTERVAL_MS = 130;

    public interface FrameListener {
        void onFrame(String base64Jpeg);
        void onStopped();
    }

    private static FrameListener frameListener;

    public static void setFrameListener(FrameListener listener) {
        frameListener = listener;
    }

    private MediaProjection projection;
    private VirtualDisplay virtualDisplay;
    private ImageReader imageReader;
    private long lastEmitAt = 0;

    private final MediaProjection.Callback projectionCallback = new MediaProjection.Callback() {
        @Override
        public void onStop() {
            stopSelf();
        }
    };

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        int resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0);
        Intent resultData = intent.getParcelableExtra(EXTRA_RESULT_DATA);
        if (resultData == null) {
            stopSelf();
            return START_NOT_STICKY;
        }

        // Must happen before getMediaProjection() -- Android requires an
        // active foreground service (with, on 14+, the mediaProjection type
        // already declared) before it will hand out a live projection.
        startForegroundNotification();

        MediaProjectionManager mgr = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        projection = mgr != null ? mgr.getMediaProjection(resultCode, resultData) : null;
        if (projection == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        // Android 14+ requires this to be registered before createVirtualDisplay.
        projection.registerCallback(projectionCallback, new Handler(Looper.getMainLooper()));

        DisplayMetrics metrics = new DisplayMetrics();
        WindowManager wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        wm.getDefaultDisplay().getRealMetrics(metrics);
        int density = metrics.densityDpi;

        int width = metrics.widthPixels;
        int height = metrics.heightPixels;
        int maxDim = 1280;
        if (width > maxDim || height > maxDim) {
            float scale = Math.min((float) maxDim / width, (float) maxDim / height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
        }

        imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
        imageReader.setOnImageAvailableListener(this::onImageAvailable, new Handler(Looper.getMainLooper()));

        virtualDisplay = projection.createVirtualDisplay(
            "MatrixChatScreenShare",
            width,
            height,
            density,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            imageReader.getSurface(),
            null,
            null
        );

        return START_NOT_STICKY;
    }

    private void onImageAvailable(ImageReader reader) {
        Image image = reader.acquireLatestImage();
        if (image == null) return;
        try {
            long now = System.currentTimeMillis();
            if (now - lastEmitAt < MIN_FRAME_INTERVAL_MS) return;
            lastEmitAt = now;
            if (frameListener == null) return;

            Image.Plane[] planes = image.getPlanes();
            ByteBuffer buffer = planes[0].getBuffer();
            int pixelStride = planes[0].getPixelStride();
            int rowStride = planes[0].getRowStride();
            int rowPadding = rowStride - pixelStride * image.getWidth();

            Bitmap bitmap = Bitmap.createBitmap(
                image.getWidth() + rowPadding / pixelStride,
                image.getHeight(),
                Bitmap.Config.ARGB_8888
            );
            bitmap.copyPixelsFromBuffer(buffer);
            if (rowPadding != 0) {
                bitmap = Bitmap.createBitmap(bitmap, 0, 0, image.getWidth(), image.getHeight());
            }

            ByteArrayOutputStream out = new ByteArrayOutputStream();
            bitmap.compress(Bitmap.CompressFormat.JPEG, 70, out);
            String base64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
            frameListener.onFrame(base64);
        } finally {
            image.close();
        }
    }

    private void startForegroundNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Screen sharing", NotificationManager.IMPORTANCE_LOW);
            channel.setShowBadge(false);
            nm.createNotificationChannel(channel);
        }

        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, launchIntent, piFlags);

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Matrix Chat")
            .setContentText("Sharing your screen")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();

        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (virtualDisplay != null) {
            virtualDisplay.release();
            virtualDisplay = null;
        }
        if (imageReader != null) {
            imageReader.close();
            imageReader = null;
        }
        if (projection != null) {
            projection.unregisterCallback(projectionCallback);
            projection.stop();
            projection = null;
        }
        if (frameListener != null) frameListener.onStopped();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
