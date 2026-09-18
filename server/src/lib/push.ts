import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { env } from "../config/env";

// Must match MESSAGE_CHANNEL_ID in web/lib/pushNotifications.ts (the
// Android app creates this channel with high importance + default sound
// on the client; a plain notification payload with no channelId lands in
// FCM's own fallback channel, which is frequently silent — that mismatch
// was the exact cause of the first test push arriving with no sound).
const ANDROID_CHANNEL_ID = "messages_v2";

// getApps().length is the memoization here — once initializeApp() actually
// succeeds there's nothing left to do on later calls. Deliberately does NOT
// cache a failure the way an earlier version did: that meant one transient
// hiccup (e.g. the env var not being fully available yet on a cold start)
// permanently disabled every push notification for the rest of the
// process's uptime, with nothing but a console.error to show for it.
function ensureInitialized(): boolean {
  if (getApps().length > 0) return true;
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) return false;

  try {
    const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
    initializeApp({ credential: cert(serviceAccount) });
    return true;
  } catch (err) {
    console.error("Failed to initialize Firebase Admin SDK:", err);
    return false;
  }
}

export interface PushNotificationTarget {
  senderId: string;
  groupId?: string;
}

/** Fire-and-forget: pushes are a best-effort convenience notification, not
 *  part of the message-delivery guarantee (the message itself already sits
 *  in the inbox and is delivered over the socket the moment the recipient
 *  reconnects — see fetchInbox/messages.controller.ts). The push body is
 *  deliberately generic; the server has no plaintext to put in it anyway.
 *
 *  `target` rides along as a plain (unencrypted) data payload — it's just
 *  routing info (who this is from / which group), not message content —
 *  so the client can open the right conversation when the notification is
 *  tapped instead of whatever thread happened to be open last. */
export async function sendPushNotification(fcmToken: string, title: string, body: string, target: PushNotificationTarget): Promise<void> {
  if (!ensureInitialized()) {
    console.error("Push notification skipped: Firebase Admin SDK not initialized (check FIREBASE_SERVICE_ACCOUNT_JSON).");
    return;
  }

  try {
    const messageId = await getMessaging().send({
      token: fcmToken,
      notification: { title, body },
      data: target.groupId ? { senderId: target.senderId, groupId: target.groupId } : { senderId: target.senderId },
      android: { priority: "high", notification: { channelId: ANDROID_CHANNEL_ID, sound: "default" } },
    });
    console.log("Push notification sent:", messageId);
  } catch (err) {
    console.error("Failed to send push notification:", err);
  }
}
