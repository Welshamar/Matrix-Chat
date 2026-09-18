import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";

// Referenced by the server (see push.ts's android.notification.channelId)
// so every push we send actually lands in a channel we control, instead of
// whatever default channel Android/FCM falls back to for a plain
// notification payload — that default channel is frequently silent, which
// is exactly the "notification with no sound" bug this fixes.
//
// The "_v2" suffix matters: Android notification channel settings are
// immutable from the app's side once a channel with a given id has ever
// been created on a device — calling createChannel() again with a
// different importance/sound/etc. is silently ignored if that id already
// exists. Devices that installed an earlier build (before importance was
// set to HIGH) are stuck with whatever the channel looked like back then
// — sound only, no heads-up banner. Bumping the id forces every device to
// get a fresh channel with the current (correct) settings.
export const MESSAGE_CHANNEL_ID = "messages_v2";

// No-ops entirely outside the native Android shell — a browser tab has no
// FCM registration to do, and this stays purely additive to it.
export async function registerForPushNotifications(onToken: (token: string) => void): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  try {
    // Created unconditionally, before the permission check below — Android
    // lets an app create/own a notification channel regardless of whether
    // POST_NOTIFICATIONS is granted (only actually *posting* a notification
    // needs that). Gating this behind the permission check meant that if
    // requestPermissions ever returned anything other than "granted", the
    // channel never got created at all — and a push naming a channel that
    // doesn't yet exist on the device is silently dropped by Android
    // entirely (no sound, no banner), which is worse than the stale-channel
    // bug this id bump was meant to fix.
    await PushNotifications.createChannel({
      id: MESSAGE_CHANNEL_ID,
      name: "Messages",
      description: "New message notifications",
      importance: 4,
      visibility: 1,
      vibration: true,
    });

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
