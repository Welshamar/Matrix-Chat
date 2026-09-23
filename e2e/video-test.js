// 1:1 video calls + Google-Meet-style emoji reactions: camera on/off, switch camera, no-camera fallback, controls auto-hide, reactions with confetti.
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
    // Lets a test pretend this device has no camera.
    const origGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (c) => {
      if (window.__noCamera && c && c.video) return Promise.reject(new DOMException("no camera", "NotFoundError"));
      return origGum(c);
    };
  });
  // DOM click: the call controls auto-hide (pointer-events: none), which would make a coordinate click race.
  page.click = async (sel) => {
    await page.waitForSelector(sel, { timeout: 15000 });
    await page.evaluate((s) => document.querySelector(s).click(), sel);
  };
  page.on("pageerror", (e) => log(`[${username}] PAGEERROR`, e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/WebSocket|favicon|Failed to load resource/.test(m.text())) log(`[${username}] console.error`, m.text().slice(0, 200));
  });
  await page.goto(`${BASE}/login`);
  await page.type('input[type="text"], input:not([type])', username);
  await page.type('input[type="password"]', "TestPass123!");
  await page.click('button[type="submit"]');
  await page.waitForSelector(".sidebar-brand-bar", { timeout: 90000 });
  await page.waitForSelector(".conn-dot.online", { timeout: 30000 });
  log(`[${username}] logged in`);
  return page;
}

// inbound video stats + the <video> element's real decoded size.
async function videoState(page) {
  return page.evaluate(async () => {
    const pc = window.__pcs[window.__pcs.length - 1];
    let framesDecoded = 0, framesSent = 0, videoIn = false, videoOut = false;
    if (pc) {
      const stats = await pc.getStats();
      stats.forEach((s) => {
        if (s.type === "inbound-rtp" && s.kind === "video") { videoIn = true; framesDecoded = s.framesDecoded || 0; }
        if (s.type === "outbound-rtp" && s.kind === "video") { videoOut = true; framesSent = s.framesSent || 0; }
      });
    }
    const rv = document.querySelector('[data-testid="call-remote-video"]');
    const sv = document.querySelector('[data-testid="call-self-video"]');
    return {
      conn: pc?.connectionState,
      framesDecoded, framesSent, videoIn, videoOut,
      remoteW: rv?.videoWidth || 0,
      selfW: sv?.videoWidth || 0,
    };
  });
}

const overlayText = (page) => page.evaluate(() => document.querySelector(".call-screen")?.innerText.replace(/\n+/g, " | ") || "(no overlay)");
const count = (page, sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
const reactionTexts = (page) => page.evaluate(() => [...document.querySelectorAll('[data-testid="call-reaction"]')].map((e) => e.innerText.replace(/\n+/g, " ").trim()));

// Controls auto-hide in a video call; a tap on the picture brings them back.
async function wake(page) {
  const hidden = await page.evaluate(() => !!document.querySelector(".call-video.chrome-hidden"));
  if (hidden) {
    await page.evaluate(() => document.querySelector('[data-testid="call-stage"]').click());
    await sleep(400);
  }
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--no-sandbox"],
  });
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok });
    log(ok ? "PASS" : "FAIL", name, detail);
  };

  try {
    const alice = await newUser(browser, "e2e_alice");
    const bob = await newUser(browser, "e2e_bob");

    await alice.type(".chat-search-row input", "e2e_bob");
    await alice.evaluate(() => document.querySelector(".chat-search-row").requestSubmit());
    await alice.waitForSelector('button[aria-label="Video call"]', { timeout: 45000 });
    check("chat header has a Video call button", true);

    // ---------- CALL 1: full video call ----------
    await alice.click('button[aria-label="Video call"]');
    await bob.waitForSelector('button[aria-label="Accept call"]', { timeout: 30000 });
    const incomingText = await overlayText(bob);
    check("bob's ring says video call", /video call/i.test(incomingText), incomingText);
    await sleep(600);
    // Alice sees her own camera full-screen while ringing.
    await alice.waitForSelector('[data-testid="call-self-video"]', { timeout: 10000 });
    await sleep(800);
    const aRing = await videoState(alice);
    check("alice sees her own camera while ringing", aRing.selfW > 0, `selfW=${aRing.selfW}`);
    await alice.screenshot({ path: path.join(OUT, "video-ringing-alice.png") });
    await bob.screenshot({ path: path.join(OUT, "video-incoming-bob.png") });

    await bob.click('button[aria-label="Accept call"]');
    await alice.waitForFunction(() => document.querySelector('[data-testid="call-remote-video"]'), { timeout: 30000 });
    await bob.waitForFunction(() => document.querySelector('[data-testid="call-remote-video"]'), { timeout: 30000 });
    await sleep(3500);

    const [a1, b1] = await Promise.all([videoState(alice), videoState(bob)]);
    check("both peer connections connected", a1.conn === "connected" && b1.conn === "connected", `${a1.conn}/${b1.conn}`);
    check("alice renders bob's video (real pixels)", a1.remoteW > 0, `w=${a1.remoteW}`);
    check("bob renders alice's video (real pixels)", b1.remoteW > 0, `w=${b1.remoteW}`);
    check("both have a self-view tile", (await count(alice, ".call-self-pip")) === 1 && (await count(bob, ".call-self-pip")) === 1);
    await sleep(2000);
    const [a2, b2] = await Promise.all([videoState(alice), videoState(bob)]);
    check("video frames keep decoding on alice", a2.framesDecoded > a1.framesDecoded + 5, `${a1.framesDecoded} -> ${a2.framesDecoded}`);
    check("video frames keep decoding on bob", b2.framesDecoded > b1.framesDecoded + 5, `${b1.framesDecoded} -> ${b2.framesDecoded}`);
    await alice.screenshot({ path: path.join(OUT, "video-connected-alice.png") });

    // ---------- controls auto-hide ----------
    await sleep(3200);
    check("controls auto-hide after a few idle seconds", await alice.evaluate(() => !!document.querySelector(".call-video.chrome-hidden")));
    await alice.screenshot({ path: path.join(OUT, "video-chrome-hidden-alice.png") });
    await wake(alice);
    check("tap on picture brings the controls back", await alice.evaluate(() => !document.querySelector(".call-video.chrome-hidden")));

    // ---------- reactions ----------
    await wake(bob);
    await bob.click('button[aria-label="Reactions"]');
    await sleep(300);
    await bob.screenshot({ path: path.join(OUT, "video-tray-bob.png") });
    await bob.click('button[aria-label="React with 🎉"]');
    await sleep(600);
    await bob.click('button[aria-label="React with 💖"]').catch(() => {});
    await sleep(700);
    const [rb, ra] = await Promise.all([reactionTexts(bob), reactionTexts(alice)]);
    check("bob sees his own reaction as 'You'", rb.some((t) => /🎉/.test(t) && /You/.test(t)), JSON.stringify(rb));
    check("alice sees bob's reaction with bob's name", ra.some((t) => /🎉/.test(t) && /e2e_bob/.test(t)), JSON.stringify(ra));
    check("alice sees the second reaction too", ra.some((t) => /💖/.test(t)), JSON.stringify(ra));
    check("party popper shows confetti", (await count(alice, ".call-confetti i")) >= 10);
    await alice.screenshot({ path: path.join(OUT, "video-reactions-alice.png") });
    await bob.screenshot({ path: path.join(OUT, "video-reactions-bob.png") });

    // Alice reacts back.
    await wake(alice);
    await alice.click('button[aria-label="Reactions"]');
    await alice.click('button[aria-label="React with 👏"]');
    await sleep(500);
    const rb2 = await reactionTexts(bob);
    check("bob sees alice's reaction with her name", rb2.some((t) => /👏/.test(t) && /e2e_alice/.test(t)), JSON.stringify(rb2));

    await sleep(4300);
    const [ca, cb] = await Promise.all([count(alice, '[data-testid="call-reaction"]'), count(bob, '[data-testid="call-reaction"]')]);
    check("reactions clear themselves after floating away", ca === 0 && cb === 0, `alice=${ca} bob=${cb}`);

    // ---------- camera off / on ----------
    await wake(alice);
    await alice.click('button[aria-label="Turn camera off"]');
    await sleep(1500);
    check("alice's self tile shows 'Camera off'", /Camera off/.test(await overlayText(alice)));
    check("no spurious audio-unlock prompt", !/Tap to hear audio/.test(await overlayText(bob)));
    check("bob sees 'camera is off' placeholder instead of a frozen frame", /camera is off/i.test(await overlayText(bob)), await overlayText(bob));
    check("bob's remote <video> is gone while camera is off", (await count(bob, '[data-testid="call-remote-video"]')) === 0);
    await bob.screenshot({ path: path.join(OUT, "video-peer-camera-off-bob.png") });

    await wake(alice);
    await alice.click('button[aria-label="Turn camera on"]');
    await sleep(500);
    const bBefore = await videoState(bob);
    await sleep(3000);
    const bAfter = await videoState(bob);
    check("bob's remote video returns when camera turns back on", (await count(bob, '[data-testid="call-remote-video"]')) === 1 && bAfter.remoteW > 0, `w=${bAfter.remoteW}`);
    check("frames flow again after camera back on (no renegotiation)", bAfter.framesDecoded > bBefore.framesDecoded + 5, `${bBefore.framesDecoded} -> ${bAfter.framesDecoded}`);

    // ---------- switch camera ----------
    await wake(alice);
    await alice.click('button[aria-label="Switch camera"]');
    await sleep(500);
    const bs1 = await videoState(bob);
    await sleep(2500);
    const bs2 = await videoState(bob);
    check("frames keep flowing after switching camera", bs2.framesDecoded > bs1.framesDecoded + 5, `${bs1.framesDecoded} -> ${bs2.framesDecoded}`);

    // ---------- mute still works in video ----------
    await wake(bob);
    await bob.click('button[aria-label="Mute"]');
    await sleep(800);
    check("alice sees bob's muted chip in video", /e2e_bob/.test(await alice.evaluate(() => document.querySelector(".call-peer-muted-chip")?.innerText || "")));
    await bob.click('button[aria-label="Unmute"]');

    // ---------- hang up + log ----------
    await wake(alice);
    await alice.click('button[aria-label="End call"]');
    await sleep(2500);
    check("hang-up clears alice", (await overlayText(alice)) === "(no overlay)");
    check("hang-up clears bob", (await overlayText(bob)) === "(no overlay)");
    const aliceThread = await alice.evaluate(() => document.querySelector(".chat-thread-col")?.innerText || "");
    check("alice's chat logs '🎥 Video call · m:ss'", /🎥 Video call · \d+:\d\d/.test(aliceThread));

    // ---------- CALL 2: voice call has no video UI but supports reactions ----------
    await sleep(1200);
    await alice.click('button[aria-label="Voice call"]');
    await bob.waitForSelector('button[aria-label="Accept call"]', { timeout: 30000 });
    await bob.click('button[aria-label="Accept call"]');
    await alice.waitForSelector('button[aria-label="Reactions"]', { timeout: 30000 });
    await sleep(1500);
    check("voice call shows no video UI", (await count(alice, ".call-video, video")) === 0 && (await count(bob, ".call-video, video")) === 0);
    await alice.click('button[aria-label="Reactions"]');
    await alice.click('button[aria-label="React with 😂"]');
    await sleep(600);
    check("reactions work in a voice call too", (await reactionTexts(bob)).some((t) => /😂/.test(t) && /e2e_alice/.test(t)));
    await alice.screenshot({ path: path.join(OUT, "voice-reactions-alice.png") });
    await alice.click('button[aria-label="End call"]');
    await sleep(2500);

    // ---------- CALL 3: video call, bob declines -> missed video call log ----------
    await alice.click('button[aria-label="Video call"]');
    await bob.waitForSelector('button[aria-label="Decline call"]', { timeout: 30000 });
    await bob.click('button[aria-label="Decline call"]');
    await sleep(3800);
    check("decline clears both overlays", (await overlayText(alice)) === "(no overlay)" && (await overlayText(bob)) === "(no overlay)");
    // Bob's thread with alice is not open; check his stored conversation preview.
    const bobList = await bob.evaluate(() => document.body.innerText);
    check("bob's chat list logs a missed video call", /Missed video call/.test(bobList), "");

    // ---------- CALL 4: callee has no camera ----------
    await bob.evaluate(() => { window.__noCamera = true; });
    await sleep(500);
    await alice.click('button[aria-label="Video call"]');
    await bob.waitForSelector('button[aria-label="Accept call"]', { timeout: 30000 });
    await bob.click('button[aria-label="Accept call"]');
    await alice.waitForFunction(() => document.querySelector(".call-video") && !/Calling|Ringing|Connecting/.test(document.querySelector(".call-status")?.innerText || ""), { timeout: 30000 });
    await sleep(3500);
    const nb = await videoState(bob);
    check("camera-less callee still receives the caller's video", nb.remoteW > 0, `w=${nb.remoteW}`);
    check("camera-less callee has no self tile or camera button", (await count(bob, ".call-self-pip")) === 0 && (await count(bob, 'button[aria-label^="Turn camera"]')) === 0);
    check("caller sees the camera-less callee as camera-off", /camera is off/i.test(await overlayText(alice)), await overlayText(alice));
    await bob.screenshot({ path: path.join(OUT, "video-nocam-bob.png") });
    await alice.screenshot({ path: path.join(OUT, "video-nocam-alice.png") });
    await wake(alice);
    await alice.click('button[aria-label="End call"]');
    await sleep(2000);

    // ---------- CALL 5: caller without a camera fails cleanly ----------
    await alice.evaluate(() => { window.__noCamera = true; });
    await sleep(300);
    await alice.click('button[aria-label="Video call"]');
    await sleep(900);
    const failText = await overlayText(alice);
    check("caller without camera sees a clear error", /camera/i.test(failText), failText);
    check("nothing rang on bob", (await count(bob, 'button[aria-label="Accept call"]')) === 0);
    await sleep(3000);
    check("failed call clears itself", (await overlayText(alice)) === "(no overlay)");
  } catch (err) {
    check("harness ran without throwing", false, err.stack || err.message);
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
