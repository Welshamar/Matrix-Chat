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
  // The media path dropped (network blip, Wi-Fi <-> mobile switch) and the client
  // is trying to bring it back on its own, or has just succeeded. The call is
  // only failed (onFailure) if that doesn't work within GIVE_UP_MS.
  onConnectionChange?: (state: "connected" | "reconnecting") => void;
  // How healthy the link is right now. tier is how much my outgoing video was
  // cut back to cope: 0 full, 1 reduced, 2 paused (audio only).
  onQuality?: (quality: { weak: boolean; tier: 0 | 1 | 2 }) => void;
  // My video was paused / resumed automatically because of the connection (not
  // because the person turned the camera off), so the other side can say why.
  onVideoPaused?: (paused: boolean) => void;
  // The peer connection reports "connected" (ICE/DTLS is up) but no inbound
  // audio RTP has actually arrived after a grace period -- a real failure
  // mode on some NAT/TURN combinations that otherwise looks like a normal,
  // silent, "successful" call with nothing to tell the user something's
  // wrong. Fires at most once per call.
  onNoAudioDetected?: () => void;
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

// --- resilience tuning ---
// A brief "disconnected" usually heals by itself; only treat it as a drop if it lasts.
const DISCONNECT_GRACE_MS = 4000;
// How often to retry an ICE restart while the media path is still down, and how
// long to keep trying before giving up on the call.
const RESTART_RETRY_MS = 7000;
const GIVE_UP_MS = 45000;
const QUALITY_INTERVAL_MS = 3000;
// How long to wait after ICE reports "connected" before treating zero
// inbound audio packets as a real problem rather than just early negotiation.
const NO_AUDIO_GRACE_MS = 8000;
// Video send limits per tier. Audio is a few tens of kbit/s, so capping video
// keeps a weak uplink from starving it (which is what makes a call "break up").
const VIDEO_BPS = [550_000, 180_000] as const;
const VIDEO_FPS = [24, 12] as const;
// Browsers default a voice call's Opus encoder to a fairly low bitrate (tuned
// for narrowband telephony, not this app's echo-cancelled/noise-suppressed
// wideband mic capture), which is what makes calls sound thin or muffled
// compared to the voice notes (96kbps -- see VoiceRecorderButton). This is
// still small next to the video budget above, so it's always affordable, not
// stepped down under a weak link the way video is -- audio is the one thing
// that must never degrade first.
const AUDIO_BPS = 64_000;

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
  private audioSender: RTCRtpSender | null = null;
  private facing: CameraFacing = "user";
  private cameraOn = false;
  private disposed = false;

  // --- reconnection ---
  private role: "caller" | "callee" = "caller";
  private everConnected = false;
  private reconnecting = false;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private giveUpTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  // --- adaptive quality ---
  private qualityTimer: ReturnType<typeof setInterval> | null = null;
  private tier: 0 | 1 | 2 = 0;
  private weak = false;
  private videoPaused = false;
  private badStreak = 0;
  private severeStreak = 0;
  private goodStreak = 0;
  private lastInbound = { received: 0, lost: 0 };
  private connectedAt: number | null = null;
  private noAudioReported = false;

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

    // A couple of pre-gathered candidates makes the first connection (and a
    // restart) quicker, which matters most on a slow link.
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, iceCandidatePoolSize: 2 });
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
    pc.onconnectionstatechange = () => this.onPcStateChange(pc);
    // Positive-only on purpose: iceConnectionState can flicker through
    // "failed" on a connection that goes on to succeed, so it is never used to
    // declare failure -- only as a second signal that we're connected.
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        this.markConnected();
      }
    };
    this.pc = pc;
    return pc;
  }

  // ---- reconnection ------------------------------------------------------
  // The media flows peer to peer, so a dropped connection is recoverable without
  // ending the call: restart ICE (a fresh round of candidate gathering, over the
  // network as it is now) via the signaling socket while the call screen shows
  // "Reconnecting". Only if that fails for GIVE_UP_MS is the call ended.

  private onPcStateChange(pc: RTCPeerConnection): void {
    if (this.disposed) return;
    const state = pc.connectionState;
    if (state === "connected") {
      this.markConnected();
    } else if (state === "disconnected") {
      // Often a blip that heals on its own -- give it a moment first.
      if (!this.disconnectTimer) {
        this.disconnectTimer = setTimeout(() => {
          this.disconnectTimer = null;
          if (!this.disposed && this.pc?.connectionState !== "connected") this.beginReconnect();
        }, DISCONNECT_GRACE_MS);
      }
    } else if (state === "failed") {
      this.beginReconnect();
    }
  }

  private markConnected(): void {
    if (this.disposed) return;
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
    if (this.reconnecting) {
      this.reconnecting = false;
      if (this.giveUpTimer) clearTimeout(this.giveUpTimer);
      if (this.restartTimer) clearTimeout(this.restartTimer);
      this.giveUpTimer = null;
      this.restartTimer = null;
      this.handlers.onConnectionChange?.("connected");
    }
    const firstConnect = this.connectedAt === null;
    this.everConnected = true;
    if (firstConnect) this.connectedAt = Date.now();
    this.handlers.onConnected?.();
    this.startQualityMonitor();
    if (firstConnect) this.logConnectionPath();
  }

  // One-off diagnostic: which candidate pair actually got selected (a
  // direct host/srflx path, vs. a relayed one through TURN). Silent calls
  // and dropped video are otherwise indistinguishable from the outside --
  // this is the one log line that answers "was TURN even involved" without
  // needing to reproduce the whole investigation again.
  private async logConnectionPath(): Promise<void> {
    try {
      const pc = this.pc;
      if (!pc) return;
      const stats = await pc.getStats();
      let pairInfo: { local?: string; remote?: string } | null = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const byId = new Map<string, any>();
      stats.forEach((r: any) => byId.set(r.id, r));
      stats.forEach((r: any) => {
        if (r.type === "candidate-pair" && (r.selected || (r.nominated && r.state === "succeeded"))) {
          const local = byId.get(r.localCandidateId);
          const remote = byId.get(r.remoteCandidateId);
          pairInfo = { local: local?.candidateType, remote: remote?.candidateType };
        }
      });
      console.info("[call] connected via", pairInfo ?? "unknown candidate pair");
    } catch {
      // Diagnostic only -- never worth failing the call over.
    }
  }

  private beginReconnect(): void {
    if (this.disposed) return;
    if (!this.reconnecting) {
      this.reconnecting = true;
      this.handlers.onConnectionChange?.("reconnecting");
      this.giveUpTimer = setTimeout(() => {
        if (this.reconnecting && !this.disposed) {
          this.handlers.onFailure(this.everConnected ? "Connection lost." : "Couldn't connect the call.");
        }
      }, GIVE_UP_MS);
    }
    this.requestRestart();
  }

  // Keeps trying, on a timer, until the connection is back or the call is given up.
  private requestRestart(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.disposed || !this.reconnecting) return;
    if (this.pc?.connectionState === "connected") {
      this.markConnected();
      return;
    }
    this.sendRestart();
    this.restartTimer = setTimeout(() => this.requestRestart(), RESTART_RETRY_MS);
  }

  // The original caller owns the offer (so both sides never offer at once);
  // if the callee is the one that noticed, it asks the caller to do it.
  private sendRestart(): void {
    if (this.role === "caller") {
      this.restartIce().catch(() => {});
    } else {
      this.socket.emit("call:restart-request", { toUserId: this.peerUserId, callId: this.callId });
    }
  }

  /** Re-negotiates ICE. Only the original caller acts on this; the callee's request just triggers it. */
  async restartIce(): Promise<void> {
    const pc = this.pc;
    if (!pc || this.disposed || this.role !== "caller") return;
    // Nothing to restart before the call was first answered.
    if (!pc.remoteDescription) return;
    if (pc.signalingState !== "stable" && pc.signalingState !== "have-local-offer") return;
    try {
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      this.socket.emit("call:restart", { toUserId: this.peerUserId, callId: this.callId, sdp: pc.localDescription ?? offer });
    } catch {
      // The next retry will try again.
    }
  }

  /** Callee side: the caller restarted ICE -- answer it. */
  async handleRestartOffer(offer: RTCSessionDescriptionInit): Promise<void> {
    const pc = this.pc;
    if (!pc || this.disposed) return;
    try {
      if (pc.signalingState !== "stable") await pc.setLocalDescription({ type: "rollback" });
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.drainPendingCandidates();
      this.socket.emit("call:restart-answer", { toUserId: this.peerUserId, callId: this.callId, sdp: pc.localDescription ?? answer });
    } catch {
      // The caller keeps retrying while the connection is down.
    }
  }

  /** Caller side: the callee's answer to a restart offer. */
  async applyRestartAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    const pc = this.pc;
    if (!pc || this.disposed || pc.signalingState !== "have-local-offer") return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      await this.drainPendingCandidates();
    } catch {
      // Stale answer for a restart that was superseded -- ignore.
    }
  }

  /** The device's network changed (came back online, switched Wi-Fi/mobile): re-check the path right away instead of waiting for it to time out. */
  notifyNetworkChange(): void {
    if (this.disposed || !this.pc?.remoteDescription) return;
    this.sendRestart();
  }

  // ---- adaptive quality --------------------------------------------------
  // Every few seconds the link is sampled (packet loss, round trip time,
  // available send bandwidth). When it's poor, outgoing video is stepped down --
  // smaller and slower, then paused entirely -- so the audio keeps flowing, and
  // stepped back up once it has been healthy for a while. It needs a couple of
  // bad (or five good) samples in a row so it doesn't flap.

  private startQualityMonitor(): void {
    if (this.qualityTimer || this.disposed) return;
    this.qualityTimer = setInterval(() => {
      this.sampleQuality().catch(() => {});
    }, QUALITY_INTERVAL_MS);
  }

  private async sampleQuality(): Promise<void> {
    const pc = this.pc;
    if (!pc || this.disposed || pc.connectionState !== "connected") return;
    const stats = await pc.getStats();

    let received = 0;
    let lost = 0;
    let outLoss = 0;
    let audioPacketsReceived = 0;
    let rttMs: number | undefined;
    let availableBps: number | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stats.forEach((r: any) => {
      if (r.type === "inbound-rtp") {
        received += r.packetsReceived || 0;
        lost += r.packetsLost || 0;
        if (r.kind === "audio" || r.mediaType === "audio") audioPacketsReceived += r.packetsReceived || 0;
      } else if (r.type === "remote-inbound-rtp") {
        outLoss = Math.max(outLoss, r.fractionLost || 0);
        if (typeof r.roundTripTime === "number") rttMs = Math.max(rttMs ?? 0, r.roundTripTime * 1000);
      } else if (r.type === "candidate-pair" && (r.selected || (r.nominated && r.state === "succeeded"))) {
        if (typeof r.currentRoundTripTime === "number") rttMs = Math.max(rttMs ?? 0, r.currentRoundTripTime * 1000);
        if (typeof r.availableOutgoingBitrate === "number") availableBps = r.availableOutgoingBitrate;
      }
    });

    const dReceived = received - this.lastInbound.received;
    const dLost = lost - this.lastInbound.lost;
    this.lastInbound = { received, lost };
    const inLoss = dReceived + dLost > 20 ? Math.max(0, dLost) / (dReceived + dLost) : 0;
    const loss = Math.max(inLoss, outLoss);

    // ICE/DTLS can report "connected" while the actual audio RTP never
    // shows up -- e.g. a TURN relay that accepted the allocation but can't
    // actually forward media. That looks, from everywhere else in this
    // class, exactly like a normal successful call, so it needs its own
    // explicit check rather than falling out of the loss/RTT logic above.
    if (!this.noAudioReported && this.connectedAt !== null && audioPacketsReceived === 0) {
      if (Date.now() - this.connectedAt > NO_AUDIO_GRACE_MS) {
        this.noAudioReported = true;
        this.handlers.onNoAudioDetected?.();
      }
    } else if (audioPacketsReceived > 0) {
      this.noAudioReported = true; // audio showed up -- never mind
    }

    // Available send bandwidth only matters while video is actually going out.
    const sendingVideo = this.cameraOn && !!this.videoSender && this.tier < 2;
    const bandwidthKnown = sendingVideo && availableBps !== undefined;
    const severe = loss > 0.2 || (rttMs ?? 0) > 1500 || (bandwidthKnown && (availableBps as number) < 80_000);
    const weak = severe || loss > 0.08 || (rttMs ?? 0) > 700 || (bandwidthKnown && (availableBps as number) < 200_000);

    this.severeStreak = severe ? this.severeStreak + 1 : 0;
    this.badStreak = weak ? this.badStreak + 1 : 0;
    this.goodStreak = weak ? 0 : this.goodStreak + 1;

    let next: 0 | 1 | 2 = this.tier;
    if (this.severeStreak >= 2) next = 2;
    else if (this.badStreak >= 2 && this.tier === 0) next = 1;
    else if (this.goodStreak >= 5 && this.tier > 0) next = (this.tier - 1) as 0 | 1;

    if (next !== this.tier) {
      this.tier = next;
      this.goodStreak = 0;
      if (next < 2) this.severeStreak = 0;
      await this.applyTier(next);
      const paused = next === 2;
      if (paused !== this.videoPaused) {
        this.videoPaused = paused;
        this.handlers.onVideoPaused?.(paused);
      }
    }

    const weakNow = weak || this.tier > 0;
    if (weakNow !== this.weak || next !== this.tier) {
      this.weak = weakNow;
      this.handlers.onQuality?.({ weak: weakNow, tier: this.tier });
    }
  }

  private async applyTier(tier: 0 | 1 | 2): Promise<void> {
    const sender = this.videoSender;
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      const enc = params.encodings[0];
      if (tier === 2) {
        enc.active = false;
      } else {
        enc.active = true;
        enc.maxBitrate = VIDEO_BPS[tier];
        enc.maxFramerate = VIDEO_FPS[tier];
        enc.scaleResolutionDownBy = tier === 0 ? 1 : 2;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (params as any).degradationPreference = "balanced";
      await sender.setParameters(params);
    } catch {
      // Not every browser accepts every field; the defaults still work.
    }
  }

  /** Current quality tier, so the UI can be initialised correctly after a re-render. */
  get isVideoPaused(): boolean {
    return this.videoPaused;
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
      if (track.kind === "audio") this.audioSender = sender;
    });
    this.cameraOn = stream.getVideoTracks().length > 0;
    this.applyAudioBitrate().catch(() => {});
    this.publishLocalStream();
  }

  private async applyAudioBitrate(): Promise<void> {
    const sender = this.audioSender;
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      params.encodings[0].maxBitrate = AUDIO_BPS;
      await sender.setParameters(params);
    } catch {
      // Not fatal -- the call still works at whatever the browser's default is.
    }
  }

  async startAsCaller(): Promise<RTCSessionDescriptionInit> {
    this.role = "caller";
    const pc = this.ensurePeerConnection();
    await this.attachLocalMedia(pc, true);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.applyTier(0).catch(() => {});
    return offer;
  }

  async acceptAsCallee(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    this.role = "callee";
    const pc = this.ensurePeerConnection();
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    await this.attachLocalMedia(pc, false);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.drainPendingCandidates();
    this.applyTier(0).catch(() => {});
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
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    if (this.giveUpTimer) clearTimeout(this.giveUpTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.qualityTimer) clearInterval(this.qualityTimer);
    this.disconnectTimer = this.giveUpTimer = this.restartTimer = null;
    this.qualityTimer = null;
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.pc?.close();
    this.pc = null;
    this.localStream = null;
    this.videoSender = null;
    this.audioSender = null;
    this.cameraOn = false;
    this.pendingCandidates = [];
  }
}
