package com.matrixchat.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ScreenCapture")
public class ScreenCapturePlugin extends Plugin implements ScreenCaptureService.FrameListener {
    private int savedResultCode;
    private Intent savedResultData;

    @PluginMethod
    public void requestPermission(PluginCall call) {
        MediaProjectionManager mgr = (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        Intent intent = mgr.createScreenCaptureIntent();
        startActivityForResult(call, intent, "handlePermissionResult");
    }

    @ActivityCallback
    private void handlePermissionResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject ret = new JSObject();
        if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
            savedResultCode = result.getResultCode();
            savedResultData = result.getData();
            ret.put("granted", true);
        } else {
            ret.put("granted", false);
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (savedResultData == null) {
            call.reject("No screen-capture permission granted yet.");
            return;
        }
        ScreenCaptureService.setFrameListener(this);
        Intent intent = new Intent(getContext(), ScreenCaptureService.class);
        intent.putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, savedResultCode);
        intent.putExtra(ScreenCaptureService.EXTRA_RESULT_DATA, savedResultData);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        ScreenCaptureService.setFrameListener(null);
        getContext().stopService(new Intent(getContext(), ScreenCaptureService.class));
        savedResultData = null;
        call.resolve();
    }

    @Override
    public void onFrame(String base64Jpeg) {
        JSObject data = new JSObject();
        data.put("base64", base64Jpeg);
        notifyListeners("frame", data);
    }

    @Override
    public void onStopped() {
        notifyListeners("stopped", new JSObject());
    }
}
