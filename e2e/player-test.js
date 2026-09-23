// WhatsApp-style voice-note player UI: waveform, scrubbing, play/pause state.
const puppeteer = require("puppeteer-core");
const path = require("path");

const BASE = process.env.E2E_BASE_URL || "http://localhost:3200";
const CHROME = process.env.E2E_CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = __dirname;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000, step = 200) => {
  const t = Date.now();
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch {} await sleep(step); }
  return false;
};

async function login(browser, u) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await ctx.overridePermissions(BASE, ["microphone"]);
  await p.setViewport({ width: 420, height: 800 });
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(e.message));
  await p.goto(BASE + "/login");
  await p.type('input[type="text"], input:not([type])', u);
  await p.type('input[type="password"]', "TestPass123!");
  await p.click('button[type="submit"]');
  await p.waitForSelector(".conn-dot.online", { timeout: 90000 });
  return p;
}

async function recordNote(page, holdMs) {
  const box = await (await page.$(".voice-mic-btn")).boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await sleep(holdMs);
  await page.mouse.up();
}

const st = (p, idx = 0) => p.evaluate((i) => {
  const root = document.querySelectorAll(".voice-msg")[i];
  if (!root) return null;
  const bars = [...root.querySelectorAll(".voice-msg-bar")].map((b) => parseFloat(b.style.height));
  return {
    label: root.querySelector(".voice-msg-play").getAttribute("aria-label"),
    duration: root.querySelector(".voice-msg-duration").innerText,
    dotLeft: parseFloat(root.querySelector(".voice-msg-dot").style.left),
    played: root.querySelectorAll(".voice-msg-bar.played").length,
    barCount: bars.length,
    barSpread: Math.max(...bars) - Math.min(...bars),
    hasMic: !!root.querySelector(".voice-msg-mic"),
    audioPaused: root.querySelector("audio").paused,
    audioDur: root.querySelector("audio").duration,
  };
}, idx);

(async () => {
  const results = [];
  const check = (name, ok, detail = "") => { results.push(ok); log(ok ? "PASS" : "FAIL", name, ok ? "" : detail); };
  const browser = await require("puppeteer-core").launch({
    executablePath: CHROME, headless: "new",
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--no-sandbox"],
  });
  try {
    const alice = await login(browser, "e2e_alice");
    const bob = await login(browser, "e2e_bob");
    await alice.type(".chat-search-row input", "e2e_bob");
    await alice.evaluate(() => document.querySelector(".chat-search-row").requestSubmit());
    await alice.waitForSelector(".voice-mic-btn");

    await recordNote(alice, 3500);
    await waitFor(() => alice.evaluate(() => document.querySelectorAll(".voice-msg").length >= 1), 60000);
    await recordNote(alice, 2000);
    await waitFor(() => alice.evaluate(() => document.querySelectorAll(".voice-msg").length >= 2), 60000);

    // Bob opens the thread.
    await bob.waitForSelector(".conversation-item", { timeout: 60000 });
    await bob.click(".conversation-item");
    await waitFor(() => bob.evaluate(() => document.querySelectorAll(".voice-msg").length >= 2), 60000);
    await sleep(2500); // let waveforms decode

    // ---- structure / decode ----
    const a0 = await st(alice, 0), b0 = await st(bob, 0);
    check("sender bubble has avatar mic badge, play button and 32 bars", a0?.hasMic && a0.barCount === 32 && /Play/.test(a0.label), JSON.stringify(a0));
    check("receiver bubble renders the same player", b0?.hasMic && b0.barCount === 32, JSON.stringify(b0));
    check("waveform is real decoded audio, not flat/placeholder-uniform", a0.barSpread > 0.15 && b0.barSpread > 0.15, `spread a=${a0.barSpread} b=${b0.barSpread}`);
    const d = (s) => { const [m, sec] = s.split(":").map(Number); return m * 60 + sec; };
    check("duration shows the recording length (~3.5s)", d(a0.duration) >= 2 && d(a0.duration) <= 5 && d(b0.duration) >= 2 && d(b0.duration) <= 5, `${a0.duration} / ${b0.duration}`);
    check("second note is shorter than the first (real durations)", d((await st(bob, 1)).duration) < d(b0.duration), `${(await st(bob, 1)).duration} vs ${b0.duration}`);

    await bob.screenshot({ path: path.join(OUT, "voice-in.png") });
    await alice.screenshot({ path: path.join(OUT, "voice-out.png") });

    // ---- play / pause / progress ----
    await bob.click(".voice-msg:nth-of-type(1) .voice-msg-play, .bubble-row:nth-of-type(1) .voice-msg-play");
    const playing = await waitFor(async () => { const s = await st(bob, 0); return s && /Pause/.test(s.label) && !s.audioPaused; }, 4000);
    check("tapping play starts playback and shows pause", !!playing);
    await sleep(1400);
    const mid = await st(bob, 0);
    check("dot and played bars advance while playing", mid.dotLeft > 5 && mid.played >= 3, JSON.stringify(mid));
    check("time counts up while playing", d(mid.duration) >= 1, mid.duration);
    await bob.screenshot({ path: path.join(OUT, "voice-playing.png") });

    // ---- one at a time ----
    await bob.click(".bubble-row:nth-of-type(2) .voice-msg-play");
    const switched = await waitFor(async () => { const a = await st(bob, 0), b = await st(bob, 1); return a.audioPaused && !b.audioPaused; }, 4000);
    check("starting a second note pauses the first", !!switched);
    await bob.click(".bubble-row:nth-of-type(2) .voice-msg-play");
    await sleep(300);

    // ---- seeking ----
    const seekBox = await (await bob.$(".bubble-row:nth-of-type(1) .voice-msg-wave")).boundingBox();
    await bob.mouse.click(seekBox.x + seekBox.width * 0.8, seekBox.y + seekBox.height / 2);
    await sleep(500);
    const seeked = await st(bob, 0);
    check("clicking the waveform seeks (dot jumps to ~80%)", seeked.dotLeft > 65 && seeked.dotLeft < 95, JSON.stringify(seeked));

    // ---- plays to the end and resets ----
    await bob.click(".bubble-row:nth-of-type(1) .voice-msg-play");
    const ended = await waitFor(async () => { const s = await st(bob, 0); return s.audioPaused && s.dotLeft === 0; }, 8000);
    const fin = await st(bob, 0);
    check("reaching the end resets to start and shows total length again", !!ended && d(fin.duration) >= 2, JSON.stringify(fin));

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
