import type { Socket } from "socket.io-client";
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
}

/** One RTCPeerConnection plus the local mic stream backing a single 1:1
 *  voice call. The server only ever sees the signaling this emits over the
 *  socket (SDP/ICE) — never the audio itself, which flows peer-to-peer (or
 *  through a TURN relay) as DTLS-SRTP once the connection is up. */
export class CallClient {
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  // Remembered here (not just on the tracks) so a mute toggled before the mic
  // has been acquired -- e.g. while the call is still ringing -- still applies.
  private muted = false;

  constructor(
    private socket: Socket,
    private peerUserId: string,
    private callId: string,
    private handlers: CallClientHandlers
  ) {}

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

  private async attachLocalAudio(pc: RTCPeerConnection): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.localStream = stream;
    stream.getAudioTracks().forEach((track) => (track.enabled = !this.muted));
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
  }

  async startAsCaller(): Promise<RTCSessionDescriptionInit> {
    const pc = this.ensurePeerConnection();
    await this.attachLocalAudio(pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    return offer;
  }

  async acceptAsCallee(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    const pc = this.ensurePeerConnection();
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    await this.attachLocalAudio(pc);
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

  dispose(): void {
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.pc?.close();
    this.pc = null;
    this.localStream = null;
    this.pendingCandidates = [];
  }
}
