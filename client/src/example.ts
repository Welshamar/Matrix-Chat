/**
 * End-to-end usage example — NOT executed automatically. Shows how two
 * devices (Alice, Bob) would use SignalClient + the socket gateway to
 * exchange an E2E-encrypted message.
 */
import { SignalClient } from "./signalClient";
import { connectSignalSocket, onSignalMessage, sendReceipt, sendSignalMessage } from "./socket";

const API_BASE_URL = "http://localhost:4000";

async function main() {
  // --- Device setup (run once per device, e.g. after login) ---
  const alice = new SignalClient("alice-user-id", "alice-jwt-token", API_BASE_URL);
  await alice.generateAndPublishBundle();

  const bob = new SignalClient("bob-user-id", "bob-jwt-token", API_BASE_URL);
  await bob.generateAndPublishBundle();

  // --- Bob listens for incoming messages over the socket gateway ---
  const bobSocket = connectSignalSocket(API_BASE_URL, "bob-jwt-token");
  onSignalMessage(bobSocket, async (msg) => {
    const plaintext = await bob.decryptMessage(msg.senderId, {
      ciphertext: msg.ciphertext,
      signalMessageType: msg.signalMessageType,
    });
    console.log(`Bob received: ${plaintext}`);
    await sendReceipt(bobSocket, msg.id, "DELIVERED");
  });

  // --- Alice encrypts locally (X3DH runs automatically on first send) and sends ---
  const aliceSocket = connectSignalSocket(API_BASE_URL, "alice-jwt-token");
  const envelope = await alice.encryptMessage("bob-user-id", "Hey Bob, this never touches the DB in plaintext.");
  await sendSignalMessage(aliceSocket, "bob-user-id", envelope.ciphertext, envelope.signalMessageType);
}

main().catch(console.error);
