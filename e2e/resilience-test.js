// Video-call resilience: network blips, ICE restart, socket drops, and adaptive quality.
const puppeteer = require("puppeteer-core");
const path = require("path");

const BASE = process.env.E2E_BASE_URL || "http://localhost:3200";
const CHROME = process.env.E2E_CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = __dirname;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newUser(browser, username) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 393, height: 852, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.overridePermissions(BASE, ["microphone", "camera", "notifications"]);
  await page.evaluateOnNewDocument(() => {
    const Orig = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = function (...args) {
      const pc = new Orig(...args);
      window.__pcs.push(pc);
      return pc;
    };
    window.RTCPeerConnection.prototype = Orig.prototype;
    // Test hook: track WebSockets so the test can drop signaling and keep it down.
    const OrigWS = window.WebSocket;
    window.__wss = [];
    window.__blockWs = false;
    window.WebSocket = function (...args) {
      // localhost:1 (nothing listens there) fails to connect same as any
      // other unreachable address, but stays inside the CSP's connect-src
      // allowlist (ws://localhost:* is only open in dev, for HMR) -- an
      // arbitrary off-origin host like 127.0.0.1 now gets blocked by CSP
      // itself before the connection is even attempted, which isn't the
      // failure mode this is trying to simulate.
      const ws = window.__blockWs ? new OrigWS("ws://localhost:1/") : new OrigWS(...args);
      window.__wss.push(ws);
      return ws;
    };
    window.WebSocket.prototype = OrigWS.prototype;
    for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) window.WebSocket[k] = OrigWS[k];
    // Test hook: pretend the network is bad by injecting lossy stats into what the app samples.
    window.__fakeLoss = 0;
    const origGetStats = Orig.prototype.getStats;
    Orig.prototype.getStats = async function (...a) {
      const report = await origGetStats.apply(this, a);
      if (!window.__fakeLoss) return report;
      const m = new Map(report);
      m.set("fake-remote-inbound", { type: "remote-inbound-rtp", kind: "video", fractionLost: window.__fakeLoss, roundTripTime: 0.05 });
      return m;
    };
  });
  page.click = async (sel) => {
    await page.waitForSelector(sel, { timeout: 20000 });
    await page.evaluate((s) => document.querySelector(s).click(), sel);
  };
  page.on("pageerror", (e) => log(`[${username}] PAGEERROR`, e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/WebSocket|favicon|Failed to load resource|ERR_FAILED/.test(m.text())) log(`[${username}] console.error`, m.text().slice(0, 200));
  });
  await page.goto(`${BASE}/login`);
  await page.type('input[type="text"], input:not([type])', username);
  await page.type('input[type="password"]', "TestPass123!");
  await page.click('button[type="submit"]');
  await page.waitForSelector(".sidebar-brand-bar", { timeout: 300000 });
  await page.waitForSelector(".conn-dot.online", { timeout: 60000 });
  log(`[${username}] logged in`);
  return page;
}

const overlay = (p) => p.evaluate(() => document.querySelector(".call-screen")?.innerText.replace(/\n+/g, " | ") || "(no overlay)");
const has = (p, sel) => p.evaluate((s) => !!document.querySelector(s), sel);

async function video(p) {
  return p.evaluate(async () => {
    const pc = window.__pcs[window.__pcs.length - 1];
    let framesDecoded = 0, conn = pc?.connectionState;
    if (pc) (await pc.getStats()).forEach((s) => { if (s.type === "inbound-rtp" && s.kind === "video") framesDecoded = s.framesDecoded || 0; });
    // Specifically the video sender's encoding -- audio now carries its own
    // maxBitrate too (see callClient.ts), so a kind-agnostic search here
    // would just as happily grab audio's and silently check the wrong thing.
    const sender = pc?.getSenders().find((x) => x.track?.kind === "video");
    const params = sender?.getParameters();
    const enc = params?.encodings?.[0];
    return { framesDecoded, conn, enc: enc ? { active: enc.active, maxBitrate: enc.maxBitrate, scale: enc.scaleResolutionDownBy } : null, ufrag: (pc?.localDescription?.sdp.match(/a=ice-ufrag:(\S+)/) || [])[1] };
  });
}

async function wake(p) {
  if (await has(p, ".call-video.chrome-hidden")) { await p.evaluate(() => document.querySelector('[data-testid="call-stage"]').click()); await sleep(300); }
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--no-sandbox"],
  });
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok }); log(ok ? "PASS" : "FAIL", name, detail); };

  try {
    const alice = await newUser(browser, "e2e_alice");
    const bob = await newUser(browser, "e2e_bob");
    await alice.type(".chat-search-row input", "e2e_bob");
    await alice.evaluate(() => document.querySelector(".chat-search-row").requestSubmit());
    await alice.waitForSelector('button[aria-label="Video call"]', { timeout: 60000 });

    await alice.click('button[aria-label="Video call"]');
    await bob.waitForSelector('button[aria-label="Accept call"]', { timeout: 60000 });
    await bob.click('button[aria-label="Accept call"]');
    await alice.waitForFunction(() => document.querySelector('[data-testid="call-remote-video"]'), { timeout: 60000 });
    await bob.waitForFunction(() => document.querySelector('[data-testid="call-remote-video"]'), { timeout: 60000 });
    await sleep(3500);
    const a0 = await video(alice), b0 = await video(bob);
    check("video call connects", a0.conn === "connected" && b0.conn === "connected", `${a0.conn}/${b0.conn}`);
    check("video send is capped by default (bitrate limit applied)", !!(a0.enc && a0.enc.maxBitrate && a0.enc.maxBitrate <= 600000), JSON.stringify(a0.enc));

    // ---- 1. socket drops for a long time: call must NOT be ended (used to die after 8s) ----
    await alice.evaluate(() => { window.__blockWs = true; window.__wss.forEach((w) => { try { w.close(); } catch (e) {} }); });
    await sleep(3000);
    check("signaling socket is actually down", !(await has(alice, ".conn-dot.online")));
    await sleep(11000);
    const midText = await overlay(alice);
    check("call survives 14s without the signaling socket (used to end after 8s)", midText !== "(no overlay)" && !/Disconnected/.test(midText), midText);
    const aMid = await video(alice), bMid = await video(bob);
    await sleep(2000);
    const bMid2 = await video(bob);
    check("media keeps flowing peer-to-peer while signaling is down", bMid2.framesDecoded > bMid.framesDecoded + 5, `${bMid.framesDecoded} -> ${bMid2.framesDecoded}`);
    await alice.evaluate(() => { window.__blockWs = false; });
    await alice.waitForSelector(".conn-dot.online", { timeout: 60000 });
    await sleep(2000);
    check("still in the call after signaling returns", (await overlay(alice)) !== "(no overlay)" && (await overlay(bob)) !== "(no overlay)");

    // ---- 2. network change on the CALLEE: caller does an ICE restart, media continues ----
    const uBefore = (await video(alice)).ufrag;
    await bob.evaluate(() => window.dispatchEvent(new Event("online")));
    await sleep(5000);
    const uAfter = (await video(alice)).ufrag;
    check("callee network change makes the caller restart ICE (new ICE credentials)", uBefore && uAfter && uBefore !== uAfter, `${uBefore} -> ${uAfter}`);
    const r1 = await video(bob);
    await sleep(2500);
    const r2 = await video(bob);
    check("video keeps flowing through the ICE restart", r2.framesDecoded > r1.framesDecoded + 5 && r2.conn === "connected", `${r1.framesDecoded} -> ${r2.framesDecoded}, ${r2.conn}`);
    check("no 'Reconnecting' left on screen after a clean restart", !/Reconnecting/.test(await overlay(alice)) && !/Reconnecting/.test(await overlay(bob)));

    // ---- 3. network change on the CALLER ----
    const u2 = (await video(alice)).ufrag;
    await alice.evaluate(() => window.dispatchEvent(new Event("online")));
    await sleep(5000);
    const u3 = (await video(alice)).ufrag;
    check("caller network change also restarts ICE", u2 !== u3, `${u2} -> ${u3}`);

    // ---- 4. a brief 'disconnected' blip heals itself: no reconnect UI ----
    await bob.evaluate(() => {
      const pc = window.__pcs[window.__pcs.length - 1];
      window.__realState = Object.getOwnPropertyDescriptor(RTCPeerConnection.prototype, "connectionState").get;
      Object.defineProperty(pc, "connectionState", { configurable: true, get: () => "disconnected" });
      pc.dispatchEvent(new Event("connectionstatechange"));
    });
    await sleep(1500);
    check("a 1.5s blip does not raise the reconnecting banner", !(await has(bob, '[data-testid="call-net-banner"]')));
    await bob.evaluate(() => {
      const pc = window.__pcs[window.__pcs.length - 1];
      delete pc.connectionState;
      pc.dispatchEvent(new Event("connectionstatechange"));
    });
    await sleep(4500);
    check("...and nothing changes once it heals", !(await has(bob, '[data-testid="call-net-banner"]')) && (await overlay(bob)) !== "(no overlay)");

    // ---- 5. a sustained drop shows 'Reconnecting', then recovers ----
    await bob.evaluate(() => {
      const pc = window.__pcs[window.__pcs.length - 1];
      Object.defineProperty(pc, "connectionState", { configurable: true, get: () => "failed" });
      pc.dispatchEvent(new Event("connectionstatechange"));
    });
    await sleep(1000);
    const rc = await overlay(bob);
    check("a failed connection shows 'Reconnecting…' instead of ending the call", /Reconnecting/.test(rc), rc);
    await bob.screenshot({ path: path.join(OUT, "resilience-reconnecting-bob.png") });
    await wake(bob);
    // Connection comes back.
    await bob.evaluate(() => {
      const pc = window.__pcs[window.__pcs.length - 1];
      delete pc.connectionState;
      pc.dispatchEvent(new Event("connectionstatechange"));
    });
    await sleep(1500);
    check("banner clears when the connection returns; call continues", !/Reconnecting/.test(await overlay(bob)) && (await overlay(bob)) !== "(no overlay)", await overlay(bob));

    // ---- 6. giving up: connection never comes back -> call ends with a message (uses a shortened window) ----
    // (covered by unit-level timing; the 45s window is too long to wait here)

    // ---- 7. adaptive quality: heavy loss -> video steps down, then pauses, other side told why ----
    await alice.evaluate(() => { window.__fakeLoss = 0.12; });
    await sleep(9000);
    const t1 = await video(alice);
    check("moderate loss reduces video quality (lower bitrate, smaller picture)", !!t1.enc && t1.enc.maxBitrate <= 200000 && t1.enc.scale >= 2 && t1.enc.active !== false, JSON.stringify(t1.enc));
    check("a 'Weak connection' banner is shown to the sender", await has(alice, '[data-testid="call-net-banner"]'), await overlay(alice));
    await alice.evaluate(() => { window.__fakeLoss = 0.35; });
    await sleep(9000);
    const t2 = await video(alice);
    check("severe loss pauses video to protect audio", t2.enc && t2.enc.active === false, JSON.stringify(t2.enc));
    await sleep(1000);
    const bobSees = await overlay(bob);
    check("the other person is told video is paused because of the connection", /paused/i.test(bobSees) && /weak connection/i.test(bobSees), bobSees);
    check("alice's own tile says video is paused", /Video paused/.test(await overlay(alice)), await overlay(alice));
    await alice.screenshot({ path: path.join(OUT, "resilience-paused-alice.png") });
    await bob.screenshot({ path: path.join(OUT, "resilience-paused-bob.png") });
    // audio is not part of that: the peer connection is still up
    check("call itself stays connected while video is paused", (await video(bob)).conn === "connected");

    // ---- 8. recovery ----
    await alice.evaluate(() => { window.__fakeLoss = 0; });
    await sleep(46000);
    const t3 = await video(alice);
    check("when the link recovers, video resumes at full quality", t3.enc && t3.enc.active !== false && t3.enc.maxBitrate >= 500000, JSON.stringify(t3.enc));
    await sleep(1500);
    check("the paused notice and weak banner go away", !(await has(alice, '[data-testid="call-net-banner"]')) && !/paused/i.test(await overlay(bob)), `${await overlay(alice)} || ${await overlay(bob)}`);
    const v1 = await video(bob);
    await sleep(2500);
    const v2 = await video(bob);
    check("bob is receiving video again", v2.framesDecoded > v1.framesDecoded + 5, `${v1.framesDecoded} -> ${v2.framesDecoded}`);

    await wake(alice);
    await alice.click('button[aria-label="End call"]');
    await sleep(2000);
  } catch (err) {
    check("harness ran without throwing", false, err.stack || err.message);
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
