package com.matrixchat.app;

import android.content.Context;
import android.media.AudioManager;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Without this, a WebView <audio> element playing a WebRTC MediaStream stays
 * on Android's default in-call audio route (the earpiece), which is quiet
 * enough that a call can sound completely silent unless you hold the phone
 * to your ear. Forcing MODE_IN_COMMUNICATION + speakerphone is the standard
 * fix for WebRTC-in-WebView apps that aren't a real telephony app.
 */
@CapacitorPlugin(name = "CallAudio")
public class CallAudioPlugin extends Plugin {

    private int previousMode;
    private boolean previousSpeakerphoneOn;
    private boolean active = false;

    @PluginMethod
    public void start(PluginCall call) {
        AudioManager audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (audioManager != null && !active) {
            previousMode = audioManager.getMode();
            previousSpeakerphoneOn = audioManager.isSpeakerphoneOn();
            audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
            audioManager.setSpeakerphoneOn(true);
            active = true;
        }
        call.resolve();
    }

    // The speaker button on the call screen. start() defaults the route to
    // speakerphone (an earpiece route is near-inaudible unless the phone is at
    // your ear); this lets the person switch to the earpiece and back.
    @PluginMethod
    public void setSpeaker(PluginCall call) {
        AudioManager audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (audioManager != null) {
            audioManager.setSpeakerphoneOn(call.getBoolean("on", true));
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        AudioManager audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (audioManager != null && active) {
            audioManager.setSpeakerphoneOn(previousSpeakerphoneOn);
            audioManager.setMode(previousMode);
            active = false;
        }
        call.resolve();
    }
}
