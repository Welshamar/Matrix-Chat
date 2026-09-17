import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";

// Referenced by the server (see push.ts's android.notification.channelId)
// so every push we send actually lands in a channel we control, instead of
// whatever default channel Android/FCM falls back to for a plain
// notification payload — that default channel is frequently silent, which
// is exactly the "notification with no sound" bug this fixes.
export const MESSAGE_CHANNEL_ID = "messages";

// No-ops entirely outside the native Android shell — a browser tab has no
// FCM registration to do, and this stays purely additive to it.
export async function registerForPushNotifications(onToken: (token: string) => void): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  try {
    const status = await PushNotifications.checkPermissions();
    let granted = status.receive === "granted";
    if (status.receive === "prompt" || status.receive === "prompt-with-rationale") {
      const requested = await PushNotifications.requestPermissions();
      granted = requested.receive === "granted";
    }
    if (!granted) return;

    // Importance 4 (HIGH) + no explicit `sound` override = Android's own
    // default notification sound, plus a heads-up banner — omitting the
    // channel entirely (or leaving importance low) is what produces a
    // silent notification.
    await PushNotifications.createChannel({
      id: MESSAGE_CHANNEL_ID,
      name: "Messages",
      description: "New message notifications",
      importance: 4,
      visibility: 1,
      vibration: true,
    });

    await PushNotifications.removeAllListeners();
    await PushNotifications.addListener("registration", (token) => onToken(token.value));
    await PushNotifications.addListener("registrationError", (err) => {
      console.error("Push registration error:", err);
    });

    await PushNotifications.register();
  } catch (err) {
    console.error("Failed to register for push notifications:", err);
  }
}
