import { Capacitor, registerPlugin } from "@capacitor/core";

interface CallForegroundPlugin {
  start(options: { video: boolean }): Promise<void>;
  stop(): Promise<void>;
}

const CallForeground = registerPlugin<CallForegroundPlugin>("CallForeground");

// Keeps the Android process (and this WebView's JS, where the WebRTC call
// itself lives) alive and unthrottled while the app is backgrounded during a
// call -- without a foreground service + its required visible notification,
// Android suspends/throttles background JS and network activity aggressively
// enough that switching apps mid-call stalls or drops it within seconds.
// No-op outside the native Android shell.
export async function startCallForegroundService(video: boolean): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await CallForeground.start({ video });
  } catch (err) {
    console.error("Failed to start call foreground service:", err);
  }
}

export async function stopCallForegroundService(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await CallForeground.stop();
  } catch (err) {
    console.error("Failed to stop call foreground service:", err);
  }
}
