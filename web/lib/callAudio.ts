import { Capacitor, registerPlugin } from "@capacitor/core";

interface CallAudioPlugin {
  start(): Promise<void>;
  stop(): Promise<void>;
}

const CallAudio = registerPlugin<CallAudioPlugin>("CallAudio");

// Forces Android's audio route to speakerphone for the duration of a call —
// without this, WebRTC audio played through a plain <audio> element stays on
// the earpiece route, which is quiet enough to sound like no audio at all.
// No-op outside the native Android shell (there's no matching web plugin).
export async function startCallAudioRouting(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await CallAudio.start();
  } catch (err) {
    console.error("Failed to route call audio to speaker:", err);
  }
}

export async function stopCallAudioRouting(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await CallAudio.stop();
  } catch (err) {
    console.error("Failed to restore call audio routing:", err);
  }
}
