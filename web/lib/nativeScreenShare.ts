import { Capacitor, registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";

interface ScreenCapturePlugin {
  requestPermission(): Promise<{ granted: boolean }>;
  start(): Promise<void>;
  stop(): Promise<void>;
  addListener(eventName: "frame", listenerFunc: (data: { base64: string }) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "stopped", listenerFunc: () => void): Promise<PluginListenerHandle>;
}

const ScreenCapture = registerPlugin<ScreenCapturePlugin>("ScreenCapture");

export interface NativeScreenShareHandle {
  stream: MediaStream;
  stop: () => void;
}

// A plain WebView has no public API for the screen-capture picker a real
// browser exposes via getDisplayMedia() -- see CallClient.canShareScreen --
// so on the native Android shell, screen sharing is bridged a different way:
// a MediaProjection-backed foreground service (ScreenCaptureService) grabs
// screen frames, JPEG-encodes them, and pushes each one over as base64. This
// draws each frame onto a canvas and pulls a MediaStreamTrack out of its
// captureStream(), which CallClient then replaceTrack()s in exactly like the
// desktop getDisplayMedia() path. Frames are capped natively to ~7-8fps to
// keep bridge traffic reasonable, so this is visibly choppier than a real
// screen share -- fine for a document or slides, not for fast motion.
export async function startNativeScreenShare(): Promise<NativeScreenShareHandle | null> {
  if (!Capacitor.isNativePlatform()) return null;

  const { granted } = await ScreenCapture.requestPermission();
  if (!granted) return null;

  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const img = new Image();

  // captureStream(0) = "manual" mode: a frame is only produced when
  // requestFrame() is called, so the outgoing video exactly tracks when a
  // new screen frame actually arrived instead of resampling on a timer.
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined;
  if (!track) return null;

  const frameHandle = await ScreenCapture.addListener("frame", ({ base64 }) => {
    img.onload = () => {
      if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
      }
      ctx.drawImage(img, 0, 0);
      track.requestFrame?.();
    };
    img.src = `data:image/jpeg;base64,${base64}`;
  });

  let stopped = false;
  const stoppedHandle = await ScreenCapture.addListener("stopped", () => {
    // The system's own "Stop sharing" affordance (or the projection just
    // dying) ends the track directly -- CallClient's existing
    // screenTrack.onended handler takes it from there, same as the
    // browser's native stop-sharing control on the desktop path.
    if (!stopped) {
      stopped = true;
      track.stop();
    }
  });

  await ScreenCapture.start();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    frameHandle.remove();
    stoppedHandle.remove();
    stream.getTracks().forEach((t) => t.stop());
    ScreenCapture.stop().catch(() => {});
  };

  return { stream, stop };
}
