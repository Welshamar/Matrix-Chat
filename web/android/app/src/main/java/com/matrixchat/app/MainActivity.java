package com.matrixchat.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CallAudioPlugin.class);
        registerPlugin(CallForegroundPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
