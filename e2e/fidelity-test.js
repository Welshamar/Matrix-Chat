// Sent images/files arrive at original quality -- pixel-exact fidelity check (not recompressed) via sharp.
const puppeteer = require("puppeteer-core");
const sharp = require("sharp");
const crypto = require("crypto");
const fs = require("fs"), path = require("path");

const BASE = process.env.E2E_BASE_URL || "http://localhost:3200";
const CHROME = process.env.E2E_CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DIR = __dirname;
const DL = path.join(DIR, "downloads");
const BIG = process.env.BIG === "1"; // also try a >5MB original (old limit was 5MB)
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 20000, step = 250) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch {} await sleep(step); } return false; };
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

async function makePhoto(file, w, h, q) {
  // Noise-heavy image: compresses badly, like a real detailed photo, so any
  // recompression anywhere in the pipeline would change the bytes.
  const raw = crypto.randomBytes(w * h * 3);
  await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: q }).toFile(file);
}

async function login(browser, u) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await ctx.overridePermissions(BASE, ["microphone"]);
  await p.setViewport({ width: 420, height: 800 });
  await p.evaluateOnNewDocument(() => {
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => {
      const s = await orig(c);
      window.__micSettings = s.getAudioTracks()[0]?.getSettings();
      window.__micConstraints = c;
      return s;
    };
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

(async () => {
  fs.rmSync(DL, { recursive: true, force: true }); fs.mkdirSync(DL, { recursive: true });
  const results = [];
  const check = (name, ok, detail = "") => { results.push(ok); log(ok ? "PASS" : "FAIL", name, ok ? "" : detail); };

  const photo = path.join(DIR, "IMG_original.jpg");
  await makePhoto(photo, 1600, 900, 92); // landscape 16:9
  const original = fs.readFileSync(photo);
  const originalHash = sha(original);
  log(`original photo: ${(original.length / 1024).toFixed(0)} KB, sha256 ${originalHash.slice(0, 16)}...`);

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-sandbox"] });
  try {
    const alice = await login(browser, "e2e_alice");
    const bob = await login(browser, "e2e_bob");
    await alice.type(".chat-search-row input", "e2e_bob");
    await alice.evaluate(() => document.querySelector(".chat-search-row").requestSubmit());
    await alice.waitForSelector(".composer-input-pill input:not([type=file])");

    // ---- voice capture settings ----
    const box = await (await alice.$(".voice-mic-btn")).boundingBox();
    await alice.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await alice.mouse.down(); await sleep(2500); await alice.mouse.up();
    await waitFor(() => alice.evaluate(() => document.querySelectorAll(".voice-msg").length >= 1), 60000);
    const mic = await alice.evaluate(() => ({ s: window.__micSettings, c: window.__micConstraints }));
    check("voice note mic: echo cancellation OFF", mic.s?.echoCancellation === false, JSON.stringify(mic.s));
    check("voice note mic: noise suppression OFF", mic.s?.noiseSuppression === false, JSON.stringify(mic.s));
    check("voice note mic: gain control ON, mono", mic.s?.autoGainControl === true && (mic.s?.channelCount ?? 1) === 1, JSON.stringify(mic.s));

    // ---- send the photo ----
    await (await alice.$('input[type="file"]')).uploadFile(photo);
    check("sender's thumbnail appears", !!(await waitFor(() => alice.evaluate(() => !!document.querySelector(".file-image")), 120000)));
    await bob.waitForSelector(".conversation-item", { timeout: 60000 });
    await bob.click(".conversation-item");
    const got = await waitFor(() => bob.evaluate(() => !!document.querySelector(".file-image")), 120000);
    check("receiver gets the photo", !!got);
    await sleep(800);

    // ---- thumbnail is not cropped ----
    const t = await bob.evaluate(() => { const i = document.querySelector(".file-image"); const r = i.getBoundingClientRect(); return { rw: r.width, rh: r.height, nw: i.naturalWidth, nh: i.naturalHeight, fit: getComputedStyle(i).objectFit }; });
    check("thumbnail keeps the photo's aspect ratio (no crop)", Math.abs(t.rw / t.rh - t.nw / t.nh) < 0.03, JSON.stringify(t));
    check("thumbnail is built from the untouched original pixels", t.nw === 1600 && t.nh === 900, JSON.stringify(t));

    // ---- viewer ----
    await bob.click(".file-image-link");
    await bob.waitForSelector(".image-viewer", { timeout: 5000 });
    await sleep(500);
    const v = await bob.evaluate(() => ({ details: document.querySelector(".image-viewer-details")?.innerText, name: document.querySelector(".image-viewer-name")?.innerText, nw: document.querySelector(".image-viewer-img").naturalWidth }));
    check("viewer shows dimensions 1600 × 900 and 'Original quality'", /Original quality/.test(v.details) && /1600 × 900/.test(v.details), JSON.stringify(v));
    check("viewer shows the exact original file size", v.details.includes(`${(original.length / 1024).toFixed(0)} KB`) || v.details.includes(`${(original.length / 1048576).toFixed(1)} MB`), `${v.details} vs ${original.length}`);
    await bob.screenshot({ path: path.join(DIR, "viewer-fit.png") });
    await bob.click(".image-viewer-img");
    await sleep(300);
    const actual = await bob.evaluate(() => { const i = document.querySelector(".image-viewer-img"); return { rw: Math.round(i.getBoundingClientRect().width), nw: i.naturalWidth, cls: document.querySelector(".image-viewer-stage").className }; });
    check("tap shows actual size (1 image px = 1 screen px)", actual.cls.includes("actual") && actual.rw === actual.nw, JSON.stringify(actual));
    await bob.click(".image-viewer-img");

    // ---- download = byte-identical ----
    const cdp = await bob.createCDPSession();
    await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: DL });
    await bob.click('.image-viewer [aria-label="Download image"]');
    const file = await waitFor(() => { const f = fs.readdirSync(DL).filter((n) => !n.endsWith(".crdownload")); return f[0]; }, 20000);
    const downloaded = file ? fs.readFileSync(path.join(DL, file)) : null;
    check("downloaded file name matches the original", file === "IMG_original.jpg", String(file));
    check("downloaded file size is byte-for-byte the original size", !!downloaded && downloaded.length === original.length, `${downloaded?.length} vs ${original.length}`);
    check("downloaded file SHA-256 is IDENTICAL to the original", !!downloaded && sha(downloaded) === originalHash, `${downloaded && sha(downloaded).slice(0, 16)} vs ${originalHash.slice(0, 16)}`);

    // ---- closes ----
    await bob.keyboard.press("Escape");
    check("Escape closes the viewer", !!(await waitFor(() => bob.evaluate(() => !document.querySelector(".image-viewer")), 3000)));

    // ---- above the OLD 5MB limit ----
    if (BIG) {
      const big = path.join(DIR, "IMG_big.jpg");
      await makePhoto(big, 3000, 2200, 95);
      const bigBytes = fs.readFileSync(big);
      log(`big photo: ${(bigBytes.length / 1048576).toFixed(1)} MB (old limit 5 MB)`);
      const t0 = Date.now();
      await (await alice.$('input[type="file"]')).uploadFile(big);
      await sleep(1500);
      const rejected = await alice.evaluate(() => document.querySelector(".attach-error")?.innerText || "");
      check("a >5MB original is accepted for sending", !/too large/.test(rejected), rejected);
      const arrived = await waitFor(() => bob.evaluate(() => document.querySelectorAll(".file-image").length >= 2), 600000, 1000);
      check(`big photo arrives intact (${((Date.now() - t0) / 1000).toFixed(0)}s)`, !!arrived);
      if (arrived) {
        const sz = await bob.evaluate(() => { const i = [...document.querySelectorAll(".file-image")].pop(); return { nw: i.naturalWidth, nh: i.naturalHeight }; });
        check("big photo keeps full 3000 × 2200 resolution", sz.nw === 3000 && sz.nh === 2200, JSON.stringify(sz));
      }
      fs.unlinkSync(big);
    }
    check("no uncaught page errors", alice.errors.length === 0 && bob.errors.length === 0, [...alice.errors, ...bob.errors].join(" | "));
  } catch (e) {
    check("harness ran without throwing", false, e.stack.split("\n").slice(0, 3).join(" "));
  } finally {
    await browser.close();
    fs.rmSync(photo, { force: true });
  }
  const ok = results.filter(Boolean).length;
  console.log(`\n${ok}/${results.length} checks passed`);
  process.exit(ok === results.length ? 0 : 1);
})();
