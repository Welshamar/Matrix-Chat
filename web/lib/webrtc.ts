// STUN resolves each peer's public address; that alone is enough for calls
// between two "easy" NATs, but a lot of home/mobile routers need a TURN
// relay to actually connect. This uses Metered's free public Open Relay
// project rather than standing up dedicated TURN infrastructure — fine for
// personal use and testing, but it's a shared, rate-limited, best-effort
// service. A real deployment expecting reliable calls at scale would want
// its own TURN credentials (e.g. Twilio) or a self-hosted coturn instance.
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:openrelay.metered.ca:80" },
  { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
];
