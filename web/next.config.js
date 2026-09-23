/** @type {import('next').NextConfig} */

const isProd = process.env.NODE_ENV === "production";

// The relay server's origin (REST + Socket.IO) — same var the app itself
// uses to know where to connect (see lib/api.ts / lib/socket.ts). Read
// directly here rather than via NEXT_PUBLIC_*: this file runs in Node at
// build/start time, not in the browser bundle, so there's no need for (and
// no benefit to) the NEXT_PUBLIC_ inlining prefix.
const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
let apiOrigin;
try {
  apiOrigin = new URL(apiUrl).origin;
} catch {
  apiOrigin = "http://localhost:4000";
}
// Socket.IO connects to the same host over ws(s):// rather than http(s)://,
// and CSP's connect-src matches by exact scheme, so both need listing.
const apiWsOrigin = apiOrigin.replace(/^http/, "ws");

// Everything the app actually loads or connects to, so the policy can be
// this tight: the relay server (REST + Socket.IO) and the STUN/TURN hosts
// WebRTC calls place directly (see lib/webrtc.ts) are the only external
// endpoints. Avatars, voice notes, and file attachments are always
// data:/blob: URLs — nothing is ever fetched from a remote CDN or image
// host (see README "Zero-knowledge guarantee"), and next/font self-hosts
// its font at build time, so there's no fonts.googleapis.com either.
const connectSrc = [
  "'self'",
  apiOrigin,
  apiWsOrigin,
  "stun:",
  "turn:",
  "blob:",
  // Next's dev-mode Fast Refresh websocket and asset requests.
  !isProd && "ws://localhost:*",
  !isProd && "http://localhost:*",
]
  .filter(Boolean)
  .join(" ");

const csp = [
  "default-src 'self'",
  // Next.js injects small inline hydration/RSC bootstrap scripts with no
  // nonce wired up here, so this can't be tightened to a bare 'self'
  // without also adding per-request nonce middleware. It still blocks
  // every *remote* script origin, which is what this exists to stop.
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src ${connectSrc}`,
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // Nothing legitimately embeds this app in a frame — blocks clickjacking.
  "frame-ancestors 'none'",
  isProd && "upgrade-insecure-requests",
]
  .filter(Boolean)
  .join("; ");

const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          // Belt-and-suspenders with frame-ancestors above — older browsers
          // that don't understand CSP3's frame-ancestors still get this.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            // Camera/mic are genuinely used here (voice notes, calls) so
            // stay allowed for this origin; everything else the app
            // doesn't use is turned off.
            value: "camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=()",
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
