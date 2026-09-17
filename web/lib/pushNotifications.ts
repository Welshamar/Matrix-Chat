import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";

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
