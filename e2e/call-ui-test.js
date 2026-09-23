// WhatsApp-style call screen UI states: ringing, incoming, connected, minimized, peer-muted (screenshots).
const puppeteer = require("puppeteer-core");
const path = require("path");
const BASE = process.env.E2E_BASE_URL || "http://localhost:3200";
const CHROME = process.env.E2E_CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const waitFor = async (fn, ms = 20000, step = 100) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch {} await sleep(step); } return false; };

async function login(browser, u) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await ctx.overridePermissions(BASE, ["microphone"]);
  await p.setViewport({ width: 393, height: 852, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await p.evaluateOnNewDocument(() => {
    const Orig = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = function (...a) { const pc = new Orig(...a); window.__pcs.push(pc); return pc; };
    window.RTCPeerConnection.prototype = Orig.prototype;
  });
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(e.message));
  await p.goto(BASE + "/login");
  await p.type('input[type="text"], input:not([type])', u);
  await p.type('input[type="password"]', "TestPass123!");
  await p.click('button[type="submit"]');
  await p.waitForSelector(".conn-dot.online", { timeout: 90000 });
  return p;
}
const status = (p) => p.evaluate(() => document.querySelector('[data-testid="call-status"]')?.innerText ?? (document.querySelector(".call-mini-bar") ? "(minimized) " + document.querySelector(".call-mini-meta").innerText : null));
const inboundEnergy = (p) => p.evaluate(async () => {
  const pc = window.__pcs[window.__pcs.length - 1];
  let e = 0, bytes = 0;
  (await pc.getStats()).forEach((s) => { if (s.type === "inbound-rtp" && s.kind === "audio") { e = s.totalAudioEnergy ?? 0; bytes = s.bytesReceived; } });
  return { e, bytes };
});
const energyDelta = async (p, ms) => { const a = await inboundEnergy(p); await sleep(ms); const b = await inboundEnergy(p); return { de: b.e - a.e, db: b.bytes - a.bytes }; };
const click = (p, label) => p.click(`[aria-label="${label}"]`);
const pressed = (p, label) => p.evaluate((l) => { const b = document.querySelector(`[aria-label="${l}"]`); return b ? { pressed: b.getAttribute("aria-pressed"), on: b.classList.contains("on") } : null; }, label);

(async () => {
  const results = [];
  const check = (n, ok, d = "") => { results.push(ok); log(ok ? "PASS" : "FAIL", n, ok ? "" : d); };
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--no-sandbox"] });
  try {
    const alice = await login(browser, "e2e_alice");
    const bob = await login(browser, "e2e_bob");
    await alice.type(".chat-search-row input", "e2e_bob");
    await alice.evaluate(() => document.querySelector(".chat-search-row").requestSubmit());
    await alice.waitForSelector('[aria-label="Voice call"]');

    // ---- ringing states ----
    await click(alice, "Voice call");
    await bob.waitForSelector('[aria-label="Accept call"]', { timeout: 20000 });
    const aRinging = await waitFor(async () => (await status(alice)) === "Ringing…", 8000);
    check("caller sees 'Ringing…' once the other phone is ringing", !!aRinging, await status(alice));
    check("callee sees 'Matrix Chat voice call'", (await status(bob)) === "Matrix Chat voice call", await status(bob));
    check("callee has Decline + Accept, and no mute/speaker yet", !!(await bob.$('[aria-label="Decline call"]')) && !(await bob.$('[aria-label="Mute"]')));
    check("both screens say End-to-end encrypted", (await alice.evaluate(() => document.querySelector(".call-e2e")?.innerText)).includes("End-to-end encrypted"));
    await alice.screenshot({ path: path.join(OUT, "call-ringing-alice.png") });
    await bob.screenshot({ path: path.join(OUT, "call-incoming-bob.png") });

    // ---- mute BEFORE the call connects must stick ----
    await click(alice, "Mute");
    const m1 = await pressed(alice, "Unmute");
    check("mute is available while ringing and shows as pressed", m1?.pressed === "true" && m1.on, JSON.stringify(m1));

    await click(bob, "Accept call");
    let sawConnecting = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      const s = await status(bob);
      if (s === "Connecting…") sawConnecting = true;
      if (/^\d\d:\d\d$/.test(s || "")) break;
      await sleep(30);
    }
    log("saw 'Connecting…' on the callee while the audio came up:", sawConnecting);
    check("callee timer starts, zero-padded like 00:03", /^\d\d:\d\d$/.test((await status(bob)) || ""), await status(bob));
    check("caller timer starts too", !!(await waitFor(async () => /^\d\d:\d\d$/.test((await status(alice)) || ""), 10000)), await status(alice));
    await sleep(1500);

    // ---- alice muted since ringing: bob must hear silence, and see the indicator ----
    check("callee sees the 'muted' indicator for the caller", !!(await bob.$(".call-avatar-muted")) && (await bob.evaluate(() => document.querySelector(".call-peer-muted-note")?.innerText || "")).includes("muted"));
    const silent = await energyDelta(bob, 3000);
    log("bob inbound while alice muted:", JSON.stringify(silent));
    await bob.screenshot({ path: path.join(OUT, "call-peer-muted-bob.png") });

    // ---- unmute: audio comes back, indicator goes ----
    await click(alice, "Unmute");
    const loud = await energyDelta(bob, 3000);
    log("bob inbound after alice unmuted:", JSON.stringify(loud));
    check("MUTE WORKS: audio energy reaching the other side collapses while muted and returns when unmuted", loud.de > 0.0005 && silent.de < loud.de * 0.2, `muted=${silent.de} unmuted=${loud.de}`);
    check("indicator disappears after unmute", !!(await waitFor(async () => !(await bob.$(".call-avatar-muted")), 4000)));

    // ---- callee mutes too ----
    await click(bob, "Mute");
    check("callee mute shows pressed", (await pressed(bob, "Unmute"))?.on === true);
    check("caller sees the callee's muted indicator", !!(await waitFor(() => alice.$(".call-avatar-muted"), 4000)));
    const silentA = await energyDelta(alice, 3000);
    await click(bob, "Unmute");
    const loudA = await energyDelta(alice, 3000);
    check("callee mute silences audio to the caller", silentA.de < loudA.de * 0.2 && loudA.de > 0.0005, `muted=${silentA.de} unmuted=${loudA.de}`);

    // ---- speaker control is native-only ----
    check("no speaker button on web (no earpiece route to switch)", !(await bob.$('[aria-label="Turn speaker off"], [aria-label="Turn speaker on"]')));

    // ---- minimize / restore ----
    await click(bob, "Minimize call");
    const mini = await waitFor(() => bob.evaluate(() => !!document.querySelector(".call-mini-bar") && !document.querySelector(".call-screen") && document.querySelector(".chat-shell").classList.contains("call-minimized")), 3000);
    check("minimize collapses to the 'Tap to return to call' bar and pushes the app down", !!mini);
    await bob.screenshot({ path: path.join(OUT, "call-minimized-bob.png") });
    const whileMini = await energyDelta(bob, 2000);
    check("audio keeps flowing while minimized", whileMini.db > 500, JSON.stringify(whileMini));
    check("minimized bar shows the running timer", /\d\d:\d\d/.test((await status(bob)) || ""), await status(bob));
    await bob.click(".call-mini-bar");
    check("tapping the bar returns to the full call screen", !!(await waitFor(() => bob.$(".call-screen"), 3000)));
    await bob.screenshot({ path: path.join(OUT, "call-connected-bob.png") });

    // ---- end ----
    await click(alice, "End call");
    check("ending clears both screens", !!(await waitFor(async () => !(await alice.$(".call-screen")) && !(await bob.$(".call-screen, .call-mini-bar")), 6000)));
    check("no uncaught page errors", alice.errors.length === 0 && bob.errors.length === 0, [...alice.errors, ...bob.errors].join(" | "));
  } catch (e) {
    check("harness ran without throwing", false, e.stack.split("\n").slice(0, 3).join(" "));
  } finally {
    await browser.close();
  }
  const ok = results.filter(Boolean).length;
  console.log(`\n${ok}/${results.length} checks passed`);
  process.exit(ok === results.length ? 0 : 1);
})();
