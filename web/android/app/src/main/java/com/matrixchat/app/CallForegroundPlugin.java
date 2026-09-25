package com.matrixchat.app;

import android.content.Intent;
import android.os.Build;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "CallForeground")
public class CallForegroundPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        boolean video = call.getBoolean("video", false);
        Intent intent = new Intent(getContext(), CallForegroundService.class);
        intent.putExtra(CallForegroundService.EXTRA_VIDEO, video);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), CallForegroundService.class));
        call.resolve();
    }
}
