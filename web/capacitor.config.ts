import type { CapacitorConfig } from '@capacitor/cli';

// This is a thin native shell, not a bundled static build: the WebView
// loads the live deployed site directly, so the Android app always shows
// whatever is currently in production without needing a new APK for every
// web change. capacitor-www is only Capacitor's required (unused) fallback.
const config: CapacitorConfig = {
  appId: 'com.matrixchat.app',
  appName: 'Matrix Chat',
  webDir: 'capacitor-www',
  server: {
    url: 'https://matrix-chat-web.vercel.app',
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
