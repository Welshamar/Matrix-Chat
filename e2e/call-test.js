// 1:1 voice call lifecycle: delayed accept, immediate accept, decline, mute toggle, hang-up from either side.
const puppeteer = require("puppeteer-core");

const BASE = process.env.E2E_BASE_URL || "http://localhost:3200";
const CHROME = process.env.E2E_CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const HOLD_SECONDS = Number(process.env.HOLD || 45);
const ACCEPT_DELAY_MS = Number(process.env.ACCEPT_DELAY || 4000);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newUser(browser, username) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await ctx.overridePermissions(BASE, ["microphone", "notifications"]);
  // Record every RTCPeerConnection so the test can read real WebRTC stats.
  await page.evaluateOnNewDocument(() => {
    const Orig = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = function (...args) {
      const pc = new Orig(...args);
      window.__pcs.push(pc);
      return pc;
    };
    window.RTCPeerConnection.prototype = Orig.prototype;
  });
  page.on("pageerror", (e) => log(`[${username}] PAGEERROR`, e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/WebSocket|favicon|Failed to load resource/.test(m.text())) log(`[${username}] console.error`, m.text().slice(0, 200));
  });
  await page.goto(`${BASE}/login`);
  await page.type('input[type="text"], input:not([type])', username);
  await page.type('input[type="password"]', "TestPass123!");
  await page.click('button[type="submit"]');
  await page.waitForSelector(".sidebar-brand-bar", { timeout: 60000 });
  await page.waitForSelector(".conn-dot.online", { timeout: 30000 });
  log(`[${username}] logged in and socket connected`);
  return page;
}

async function rtcState(page) {
  return page.evaluate(async () => {
    const pc = window.__pcs[window.__pcs.length - 1];
    if (!pc) return null;
    const stats = await pc.getStats();
    let audioIn = 0, audioOut = 0, pairState = null, remoteType = null;
    stats.forEach((s) => {
      if (s.type === "inbound-rtp" && s.kind === "audio") audioIn = s.bytesReceived;
      if (s.type === "outbound-rtp" && s.kind === "audio") audioOut = s.bytesSent;
      if (s.type === "candidate-pair" && s.nominated) pairState = s.state;
    });
    return { conn: pc.connectionState, ice: pc.iceConnectionState, audioIn, audioOut, pairState };
  });
}

const overlayText = (page) => page.evaluate(() => document.querySelector(".call-screen")?.innerText.replace(/\n+/g, " | ") || "(no overlay)");

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

    // Alice opens a chat with Bob.
    await alice.type(".chat-search-row input", "e2e_bob");
    await alice.evaluate(() => document.querySelector(".chat-search-row").requestSubmit());
    await alice.waitForSelector('button[aria-label="Voice call"]', { timeout: 30000 });
    check("alice opened conversation with bob", true);

    // ---- CALL 1: delayed accept, then hold ----
    await alice.click('button[aria-label="Voice call"]');
    await bob.waitForSelector('button[aria-label="Accept call"]', { timeout: 20000 });
    check("bob got incoming call ring", true);
    log(`waiting ${ACCEPT_DELAY_MS}ms before accepting (lets caller's ICE candidates arrive early)`);
    await sleep(ACCEPT_DELAY_MS);
    await bob.click('button[aria-label="Accept call"]');

    const t0 = Date.now();
    let dropped = null;
    let lastReport = 0;
    while ((Date.now() - t0) / 1000 < HOLD_SECONDS) {
      await sleep(1000);
      const [a, b, ta, tb] = await Promise.all([rtcState(alice), rtcState(bob), overlayText(alice), overlayText(bob)]);
      const elapsed = Math.round((Date.now() - t0) / 1000);
      if (elapsed - lastReport >= 5) {
        lastReport = elapsed;
        log(`t+${elapsed}s alice=${JSON.stringify(a)} | ${ta}`);
        log(`t+${elapsed}s bob  =${JSON.stringify(b)} | ${tb}`);
      }
      if (ta === "(no overlay)" || tb === "(no overlay)" || /failed|Disconnected/i.test(ta + tb)) {
        dropped = { elapsed, ta, tb, a, b };
        break;
      }
    }
    check(`call stayed up for ${HOLD_SECONDS}s`, !dropped, dropped ? JSON.stringify(dropped) : "");

    const [a, b] = await Promise.all([rtcState(alice), rtcState(bob)]);
    check("alice peer connection is 'connected'", a?.conn === "connected", JSON.stringify(a));
    check("bob peer connection is 'connected'", b?.conn === "connected", JSON.stringify(b));
    check("audio bytes flowing alice -> bob", (b?.audioIn || 0) > 1000, `bob received ${b?.audioIn}`);
    check("audio bytes flowing bob -> alice", (a?.audioIn || 0) > 1000, `alice received ${a?.audioIn}`);

    // Mute toggle should not end the call.
    if (!dropped) {
      await bob.click('button[aria-label="Mute"]');
      await sleep(1000);
      check("mute toggle keeps call up", (await overlayText(bob)) !== "(no overlay)");
      await bob.click('button[aria-label="Unmute"]');
    }

    // Hang up from Alice; Bob's UI must clear too.
    if (!dropped) {
      await alice.click('button[aria-label="End call"]');
      await sleep(2500);
      check("hang-up clears alice overlay", (await overlayText(alice)) === "(no overlay)");
      check("hang-up clears bob overlay", (await overlayText(bob)) === "(no overlay)");
    }

    // ---- CALL 2: decline path ----
    await sleep(1500);
    await alice.click('button[aria-label="Voice call"]');
    await bob.waitForSelector('button[aria-label="Decline call"]', { timeout: 20000 });
    await bob.click('button[aria-label="Decline call"]');
    await sleep(3500);
    check("decline clears bob overlay", (await overlayText(bob)) === "(no overlay)", await overlayText(bob));
    check("decline clears alice overlay", (await overlayText(alice)) === "(no overlay)", await overlayText(alice));

    // ---- CALL 3: immediate accept ----
    await alice.click('button[aria-label="Voice call"]');
    await bob.waitForSelector('button[aria-label="Accept call"]', { timeout: 20000 });
    await bob.click('button[aria-label="Accept call"]');
    await sleep(6000);
    const [a3, b3] = await Promise.all([rtcState(alice), rtcState(bob)]);
    check("immediate-accept call connects on both sides", a3?.conn === "connected" && b3?.conn === "connected", `${a3?.conn}/${b3?.conn}`);
    await alice.click('button[aria-label="End call"]');
    await sleep(1500);
  } catch (err) {
    check("harness ran without throwing", false, err.message);
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
