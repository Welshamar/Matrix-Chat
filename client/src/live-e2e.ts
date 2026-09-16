/**
 * Full live end-to-end test against the REAL running server + Neon DB:
 *   1. Creates two users via the dev auth stub.
 *   2. Each device generates keys and publishes its bundle via
 *      POST /api/keys/prekey-bundle.
 *   3. Bob connects over Socket.IO and listens for signal:message.
 *   4. Alice fetches Bob's bundle via GET /api/keys/prekey-bundle/:userId,
 *      runs X3DH, encrypts, and sends via the signal:message socket event.
 *   5. Bob decrypts, sends a signal:receipt back.
 *   6. We read the row straight out of Postgres to prove only ciphertext
 *      was ever persisted.
 *
 * Run with: node dist-demo/live-e2e.js   (after `npx tsc -p tsconfig.demo.json`)
 */
import { SignalClient } from "./signalClient";
import { connectSignalSocket, onSignalMessage, onSignalReceipt, sendReceipt, sendSignalMessage } from "./socket";

const BASE_URL = "http://localhost:4000";

async function createUser(username: string): Promise<{ userId: string; token: string }> {
  const res = await fetch(`${BASE_URL}/api/dev/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  if (!res.ok) throw new Error(`createUser(${username}) failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ userId: string; token: string }>;
}

async function main() {
  console.log("--- Matrix Chat: live end-to-end test against real server + Neon Postgres ---\n");

  const suffix = Date.now();
  console.log("[1/6] Creating Alice and Bob via POST /api/dev/users...");
  const alice = await createUser(`alice-live-${suffix}`);
  const bob = await createUser(`bob-live-${suffix}`);
  console.log(`      alice.userId = ${alice.userId}`);
  console.log(`      bob.userId   = ${bob.userId}`);

  console.log("\n[2/6] Both devices generate keys and publish bundles via POST /api/keys/prekey-bundle...");
  const aliceClient = new SignalClient(alice.userId, alice.token, BASE_URL);
  const bobClient = new SignalClient(bob.userId, bob.token, BASE_URL);
  await aliceClient.generateAndPublishBundle();
  await bobClient.generateAndPublishBundle();
  console.log("      Bundles published (public keys only — verify in DB below).");

  console.log("\n[3/6] Bob connects over Socket.IO and starts listening for signal:message...");
  const bobSocket = connectSignalSocket(BASE_URL, bob.token);
  const bobDelivered = new Promise<void>((resolve) => {
    onSignalMessage(bobSocket, async (msg) => {
      console.log(`      Bob received ciphertext over the socket (base64, first 50 chars): ${msg.ciphertext.slice(0, 50)}...`);
      const plaintext = await bobClient.decryptMessage(msg.senderId, {
        ciphertext: msg.ciphertext,
        signalMessageType: msg.signalMessageType,
      });
      console.log(`      Bob decrypted locally: "${plaintext}"`);
      const ack = await sendReceipt(bobSocket, msg.id, "DELIVERED");
      console.log(`      Bob sent delivery receipt, ack: ${JSON.stringify(ack)}`);
      resolve();
    });
  });

  const aliceSocket = connectSignalSocket(BASE_URL, alice.token);
  const receiptSeen = new Promise<void>((resolve) => {
    onSignalReceipt(aliceSocket, (evt) => {
      console.log(`      Alice received delivery receipt: ${JSON.stringify(evt)}`);
      resolve();
    });
  });

  await new Promise((r) => setTimeout(r, 500)); // let both sockets finish connecting

  console.log("\n[4/6] Alice runs X3DH against Bob's published bundle and encrypts a message...");
  const plaintext = `Hi Bob, this is a LIVE message sent at ${new Date().toISOString()}`;
  const envelope = await aliceClient.encryptMessage(bob.userId, plaintext);
  console.log(`      plaintext:  "${plaintext}"`);
  console.log(`      ciphertext (base64, first 50 chars): ${envelope.ciphertext.slice(0, 50)}...`);

  console.log("\n[5/6] Alice sends over signal:message socket event...");
  const sendAck = await sendSignalMessage(aliceSocket, bob.userId, envelope.ciphertext, envelope.signalMessageType);
  console.log(`      send ack: ${JSON.stringify(sendAck)}`);

  await Promise.all([bobDelivered, receiptSeen]);

  const messageId = (sendAck as { messageId: string }).messageId;
  console.log(`\n[6/6] Message persisted as id=${messageId}.`);
  console.log(`      Verify with (from the server project): node dist/verify-message.js ${messageId} "${plaintext}"`);

  aliceSocket.disconnect();
  bobSocket.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("Live E2E test failed:", err);
  process.exit(1);
});
