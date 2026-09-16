/**
 * Standalone, network-free demo: proves the actual Signal Protocol code
 * (X3DH via KeyHelper/SessionBuilder + Double Ratchet via SessionCipher)
 * works end-to-end. Two in-memory stores stand in for Alice's and Bob's
 * devices; the "server" step is just copying Bob's PUBLIC bundle over,
 * exactly like the real /api/keys/prekey-bundle endpoints would.
 *
 * Run with: npx ts-node src/demo.ts   (or compile + node dist/demo.js)
 */
import { KeyHelper, SessionBuilder, SessionCipher, SignalProtocolAddress } from "@privacyresearch/libsignal-protocol-typescript";
import { SignalProtocolStore } from "./storage/SignalProtocolStore";
import { arrayBufferToBase64, base64ToArrayBuffer, base64ToBinaryString, binaryStringToBase64 } from "./encoding";

const DEVICE_ID = 1;

async function generateBundle(store: SignalProtocolStore) {
  const identityKeyPair = await KeyHelper.generateIdentityKeyPair();
  const registrationId = KeyHelper.generateRegistrationId();
  const signedPreKey = await KeyHelper.generateSignedPreKey(identityKeyPair, 1);
  const oneTimePreKey = await KeyHelper.generatePreKey(1);

  await store.put("identityKey", identityKeyPair);
  await store.put("registrationId", registrationId);
  await store.storeSignedPreKey(signedPreKey.keyId, signedPreKey.keyPair);
  await store.storePreKey(oneTimePreKey.keyId, oneTimePreKey.keyPair);

  // This is exactly what POST /api/keys/prekey-bundle would receive:
  // public keys only, base64-encoded.
  return {
    registrationId,
    identityKey: identityKeyPair.pubKey,
    signedPreKey: { keyId: signedPreKey.keyId, publicKey: signedPreKey.keyPair.pubKey, signature: signedPreKey.signature },
    preKey: { keyId: oneTimePreKey.keyId, publicKey: oneTimePreKey.keyPair.pubKey },
  };
}

async function main() {
  console.log("--- Matrix Chat: live Signal Protocol demo ---\n");

  const aliceStore = new SignalProtocolStore();
  const bobStore = new SignalProtocolStore();

  console.log("[1/5] Generating identity + signed prekey + one-time prekey for Alice and Bob...");
  const aliceBundle = await generateBundle(aliceStore);
  const bobBundle = await generateBundle(bobStore);
  console.log(`      Alice identity pubkey (base64, first 24 chars): ${arrayBufferToBase64(aliceBundle.identityKey).slice(0, 24)}...`);
  console.log(`      Bob   identity pubkey (base64, first 24 chars): ${arrayBufferToBase64(bobBundle.identityKey).slice(0, 24)}...`);

  console.log("\n[2/5] Alice fetches Bob's PUBLIC bundle (this is what GET /api/keys/prekey-bundle/:userId returns) and runs X3DH...");
  const aliceToBobAddress = new SignalProtocolAddress("bob", DEVICE_ID);
  const builder = new SessionBuilder(aliceStore, aliceToBobAddress);
  await builder.processPreKey({
    identityKey: bobBundle.identityKey,
    registrationId: bobBundle.registrationId,
    signedPreKey: bobBundle.signedPreKey,
    preKey: bobBundle.preKey,
  });
  console.log("      Session established on Alice's side.");

  const plaintext = "Hey Bob — this plaintext never touches the server or the DB.";
  console.log(`\n[3/5] Alice encrypts: "${plaintext}"`);
  const aliceCipher = new SessionCipher(aliceStore, aliceToBobAddress);
  const encrypted = await aliceCipher.encrypt(new TextEncoder().encode(plaintext).buffer);
  const ciphertextBase64 = binaryStringToBase64(encrypted.body as string);
  console.log(`      signalMessageType = ${encrypted.type} (3 = PreKeyWhisperMessage, first message of a session)`);
  console.log(`      ciphertext (base64, what the DB actually stores): ${ciphertextBase64.slice(0, 60)}...`);
  console.log(`      ^ this row is what Message.ciphertext holds server-side. It is NOT the plaintext above.`);

  console.log("\n[4/5] Relay hands the same base64 blob to Bob (simulating the signal:message socket event)...");
  const bobFromAliceAddress = new SignalProtocolAddress("alice", DEVICE_ID);
  const bobCipher = new SessionCipher(bobStore, bobFromAliceAddress);
  const body = base64ToBinaryString(ciphertextBase64);
  const decryptedBuffer = await bobCipher.decryptPreKeyWhisperMessage(body, "binary");
  const decrypted = new TextDecoder().decode(decryptedBuffer);

  console.log(`\n[5/5] Bob decrypts locally: "${decrypted}"`);
  console.log(`\nRound trip correct: ${decrypted === plaintext}`);

  console.log("\n--- Reply message, to show the ratchet has advanced past the initial PreKey message ---");
  const reply = "Got it, Alice. Ratchet advanced.";
  const bobReply = await bobCipher.encrypt(new TextEncoder().encode(reply).buffer);
  console.log(`Bob's reply signalMessageType = ${bobReply.type} (1 = ordinary WhisperMessage, no prekey needed anymore)`);
  const aliceDecryptsReply = await aliceCipher.decryptWhisperMessage(base64ToBinaryString(binaryStringToBase64(bobReply.body as string)), "binary");
  console.log(`Alice decrypts Bob's reply: "${new TextDecoder().decode(aliceDecryptsReply)}"`);
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
