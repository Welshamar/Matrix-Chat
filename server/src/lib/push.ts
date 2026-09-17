import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { env } from "../config/env";

let ready: boolean | null = null;

function ensureInitialized(): boolean {
  if (ready !== null) return ready;

  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    ready = false;
    return ready;
  }

  try {
    const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
    if (getApps().length === 0) {
      initializeApp({ credential: cert(serviceAccount) });
    }
    ready = true;
  } catch (err) {
    console.error("Failed to initialize Firebase Admin SDK:", err);
    ready = false;
  }
  return ready;
}

/** Fire-and-forget: pushes are a best-effort convenience notification, not
 *  part of the message-delivery guarantee (the message itself already sits
 *  in the inbox and is delivered over the socket the moment the recipient
 *  reconnects — see fetchInbox/messages.controller.ts). The push body is
 *  deliberately generic; the server has no plaintext to put in it anyway. */
export async function sendPushNotification(fcmToken: string, title: string, body: string): Promise<void> {
  if (!ensureInitialized()) return;

  try {
    await getMessaging().send({
      token: fcmToken,
      notification: { title, body },
      android: { priority: "high" },
    });
  } catch (err) {
    console.error("Failed to send push notification:", err);
  }
}
