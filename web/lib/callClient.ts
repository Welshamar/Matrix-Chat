import type { Socket } from "socket.io-client";
import { Capacitor } from "@capacitor/core";
import { ICE_SERVERS } from "./webrtc";

export interface CallClientHandlers {
  onRemoteStream: (stream: MediaStream) => void;
  // Fired for a local failure (mic denied, ICE failed, connection dropped)
  // after the call was already under way — the caller/callee flows handle
  // their own reject/no-answer cases separately.
  onFailure: (reason: string) => void;
  // Fired when the peer connection is actually up (ICE connected) -- as
  // opposed to onRemoteStream, which fires as soon as the remote track is
  // negotiated, before any audio can flow. May fire more than once.
  onConnected?: () => void;
  // Our own media changed (first acquired, camera turned on/off, camera
  // flipped). Always a fresh MediaStream so the UI's self-view re-attaches.
  onLocalStream?: (stream: MediaStream) => void;
}

export type CameraFacing = "user" | "environment";

type MediaDevice = "camera" | "microphone" | "camera or microphone";

/** A getUserMedia failure translated into something a person can act on. */
export class CallMediaError extends Error {
  constructor(message: string, readonly original: unknown) {
    super(message);
    this.name = "CallMediaError";
  }
}

// Where to fix a blocked permission differs completely between the Android app
// and a browser, so say the right thing for each.
function describeMediaError(err: unknown, device: MediaDevice): CallMediaError {
  const name = err instanceof DOMException || err instanceof Error ? err.name : "";
  const native = Capacitor.isNativePlatform();
  let message: string;
  if (name === "NotAllowedError" || name === "SecurityError") {
    message = native
      ? `Allow ${device} access for Matrix Chat in Settings > Apps > Matrix Chat > Permissions.`
      : `${device[0].toUpperCase()}${device.slice(1)} access is blocked. Allow it from the lock icon in the address bar, then try again.`;
  } else if (name === "NotFoundError" || name === "OverconstrainedError") {
    message = `No ${device} found on this device.`;
  } else if (name === "NotReadableError" || name === "AbortError") {
    message = `Your ${device} is being used by another app.`;
  } else {
    message = `Couldn't access your ${device}.`;
  }
  return new CallMediaError(message, err);
}

const AUDIO_CONSTRAINTS: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

// 640x480 @ 24fps: sharp on a phone screen, and light enough to hold up on
// mobile data. WebRTC still adapts down on a weak link.
function videoConstraints(facing: CameraFacing): MediaTrackConstraints {
  return { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } };
}

/** One RTCPeerConnection plus the local mic (and, for a video call, camera)
 *  backing a single 1:1 call. The server only ever sees the signaling this
 *  emits over the socket (SDP/ICE) — never the media itself, which flows
 *  peer-to-peer (or through a TURN relay) as DTLS-SRTP once the connection
 *  is up. */
export class CallClient {
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  // Remembered here (not just on the tracks) so a mute toggled before the mic
  // has been acquired -- e.g. while the call is still ringing -- still applies.
  private muted = false;
  private videoSender: RTCRtpSender | null = null;
  private facing: CameraFacing = "user";
  private cameraOn = false;
  private disposed = false;

  constructor(
    private socket: Socket,
    private peerUserId: string,
    private callId: string,
    private handlers: CallClientHandlers,
    private video = false
  ) {}

  /** False for a voice call, or if this side has no usable camera -- the
   *  camera/flip controls are hidden then, since there's no sender to drive. */
  get canSendVideo(): boolean {
    return this.videoSender !== null;
  }

  get isCameraOn(): boolean {
    return this.cameraOn;
  }

  get cameraFacing(): CameraFacing {
    return this.facing;
  }

  private ensurePeerConnection(): RTCPeerConnection {
    if (this.pc) return this.pc;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.socket.emit("call:ice", {
          toUserId: this.peerUserId,
          callId: this.callId,
          candidate: e.candidate.toJSON(),
        });
      }
    };
    pc.ontrack = (e) => {
      if (e.streams[0]) this.handlers.onRemoteStream(e.streams[0]);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") this.handlers.onConnected?.();
      if (pc.connectionState === "failed") {
        this.handlers.onFailure("Call connection failed.");
      }
    };
    // Positive-only on purpose: iceConnectionState can flicker through
    // "failed" on a connection that goes on to succeed, so it is never used to
    // declare failure -- only as a second signal that we're connected.
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        this.handlers.onConnected?.();
      }
    };
    this.pc = pc;
    return pc;
  }

  private publishLocalStream(): void {
    if (this.localStream) this.handlers.onLocalStream?.(new MediaStream(this.localStream.getTracks()));
  }

  private async acquireVideoTrack(facing: CameraFacing): Promise<MediaStreamTrack> {
    const stream = await this.getMedia({ video: videoConstraints(facing) }, "camera");
    return stream.getVideoTracks()[0];
  }

  // getUserMedia can sit on a permission prompt for as long as the person
  // takes to answer. If the call was ended in the meantime, the stream that
  // finally arrives must not be kept -- otherwise the camera/mic would stay
  // switched on for a call that no longer exists.
  private async getMedia(constraints: MediaStreamConstraints, device: MediaDevice = "camera or microphone"): Promise<MediaStream> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      throw this.disposed ? err : describeMediaError(err, device);
    }
    if (this.disposed) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("Call ended.");
    }
    return stream;
  }

  // A combined camera+mic request fails with one opaque error, so probe the
  // microphone on its own to tell the person which of the two is the problem.
  private async explainMediaFailure(failure: unknown): Promise<Error> {
    const cause = failure instanceof CallMediaError ? failure.original : failure;
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
      probe.getTracks().forEach((t) => t.stop());
      return describeMediaError(cause, "camera");
    } catch (micErr) {
      return describeMediaError(micErr, "microphone");
    }
  }

  // `cameraRequired`: a caller placing a video call fails outright if there's
  // no camera (there's nothing to show). A callee accepting one still takes
  // the call with audio only and simply receives the caller's video.
  private async attachLocalMedia(pc: RTCPeerConnection, cameraRequired: boolean): Promise<void> {
    let stream: MediaStream;
    if (this.video) {
      try {
        stream = await this.getMedia({ audio: AUDIO_CONSTRAINTS, video: videoConstraints(this.facing) });
      } catch (err) {
        if (this.disposed) throw err;
        if (cameraRequired) throw await this.explainMediaFailure(err);
        stream = await this.getMedia({ audio: AUDIO_CONSTRAINTS }, "microphone");
      }
    } else {
      stream = await this.getMedia({ audio: AUDIO_CONSTRAINTS }, "microphone");
    }

    this.localStream = stream;
    stream.getAudioTracks().forEach((track) => (track.enabled = !this.muted));
    stream.getTracks().forEach((track) => {
      const sender = pc.addTrack(track, stream);
      if (track.kind === "video") this.videoSender = sender;
    });
    this.cameraOn = stream.getVideoTracks().length > 0;
    this.publishLocalStream();
  }

  async startAsCaller(): Promise<RTCSessionDescriptionInit> {
    const pc = this.ensurePeerConnection();
    await this.attachLocalMedia(pc, true);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    return offer;
  }

  async acceptAsCallee(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    const pc = this.ensurePeerConnection();
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    await this.attachLocalMedia(pc, false);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.drainPendingCandidates();
    return answer;
  }

  async applyAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    if (!this.pc) return;
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
    await this.drainPendingCandidates();
  }

  // ICE candidates can (and often do) arrive before the remote description
  // is set — addIceCandidate would reject them, so they're queued and
  // replayed once there's a remote description to apply them against.
  async addRemoteIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.pc?.remoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch {
      // A candidate arriving after teardown is harmless — nothing to do.
    }
  }

  private async drainPendingCandidates(): Promise<void> {
    const queued = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of queued) {
      try {
        await this.pc?.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        // Ignore — see addRemoteIceCandidate.
      }
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.localStream?.getAudioTracks().forEach((track) => (track.enabled = !muted));
  }

  // Turning the camera off releases the hardware (so the camera light goes
  // out) rather than just sending black frames; turning it back on opens it
  // again. Either way it's a replaceTrack on the existing sender, so no
  // renegotiation with the other side is needed.
  async setCameraEnabled(on: boolean): Promise<boolean> {
    const sender = this.videoSender;
    const stream = this.localStream;
    if (!sender || !stream) return false;

    if (!on) {
      stream.getVideoTracks().forEach((t) => {
        t.stop();
        stream.removeTrack(t);
      });
      await sender.replaceTrack(null);
      this.cameraOn = false;
    } else {
      const track = await this.acquireVideoTrack(this.facing);
      stream.addTrack(track);
      await sender.replaceTrack(track);
      this.cameraOn = true;
    }
    this.publishLocalStream();
    return true;
  }

  // Front <-> back camera. Most phones can only have one camera open at a
  // time, so the current one is released before the other is opened.
  async switchCamera(): Promise<CameraFacing | null> {
    const sender = this.videoSender;
    const stream = this.localStream;
    if (!sender || !stream) return null;
    const next: CameraFacing = this.facing === "user" ? "environment" : "user";

    if (!this.cameraOn) {
      this.facing = next;
      return next;
    }

    stream.getVideoTracks().forEach((t) => {
      t.stop();
      stream.removeTrack(t);
    });
    let track: MediaStreamTrack;
    try {
      track = await this.acquireVideoTrack(next);
      this.facing = next;
    } catch {
      // The other camera wouldn't open -- go back to the one we had.
      track = await this.acquireVideoTrack(this.facing);
    }
    stream.addTrack(track);
    await sender.replaceTrack(track);
    this.publishLocalStream();
    return this.facing;
  }

  dispose(): void {
    this.disposed = true;
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.pc?.close();
    this.pc = null;
    this.localStream = null;
    this.videoSender = null;
    this.cameraOn = false;
    this.pendingCandidates = [];
  }
}
