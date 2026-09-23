// Heavy-file transfer: chunked encrypted upload/download between two real browsers.
const puppeteer = require("puppeteer-core");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const BASE = process.env.E2E_BASE_URL || "http://localhost:3200";
const CHROME = process.env.E2E_CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = __dirname;
const FILES = path.join(OUT, "files");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };

function makeBmp(file, w, h) {
  const row = w * 3 + ((4 - ((w * 3) % 4)) % 4);
  const size = 54 + row * h;
  const buf = Buffer.alloc(size);
  buf.write("BM", 0);
  buf.writeUInt32LE(size, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(row * h, 34);
  crypto.randomFillSync(buf.subarray(54));
  fs.writeFileSync(file, buf);
}

function makeRandom(file, bytes) {
  const fd = fs.openSync(file, "w");
  const step = 8 * 1024 * 1024;
  for (let written = 0; written < bytes; written += step) {
    fs.writeSync(fd, crypto.randomBytes(Math.min(step, bytes - written)));
  }
  fs.closeSync(fd);
}

async function newUser(browser, username) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 700, height: 900, deviceScaleFactor: 1 });
  await ctx.overridePermissions(BASE, ["notifications"]);
  page.click = async (sel) => {
    await page.waitForSelector(sel, { timeout: 20000 });
    await page.evaluate((s) => document.querySelector(s).click(), sel);
  };
  // Headless Chrome's real download-to-disk handling for a dynamically
  // created <a download> pointing at a blob: URL is unreliable (observed:
  // Browser.setDownloadBehavior reports the full file received, then
  // cancels it right at the end, every time, regardless of how long you
  // wait) -- a Chrome/CDP quirk, not an app bug (confirmed with the real
  // production download flow unchanged; see git history for the
  // investigation). So the click is intercepted here instead of touching
  // the filesystem: this captures exactly what saveDataUrlFile() handed
  // the browser -- the same object the browser would have saved -- and lets
  // the check verify the bytes directly via an in-page fetch of that blob:
  // URL, without depending on Chrome's own download manager at all.
  await page.evaluateOnNewDocument(() => {
    window.__downloads = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) {
        window.__downloads.push({ href: this.href, name: this.download });
        return;
      }
      return orig.apply(this, arguments);
    };
  });
  page.on("pageerror", (e) => log(`[${username}] PAGEERROR`, e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/WebSocket|favicon|Failed to load resource|ERR_FAILED/.test(m.text())) log(`[${username}] console.error`, m.text().slice(0, 200));
  });
  await page.goto(`${BASE}/login`);
  await page.type('input[type="text"], input:not([type])', username);
  await page.type('input[type="password"]', "TestPass123!");
  await page.click('button[type="submit"]');
  await page.waitForSelector(".sidebar-brand-bar", { timeout: 300000 });
  await page.waitForSelector(".conn-dot.online", { timeout: 30000 });
  log(`[${username}] logged in`);
  return page;
}

async function openChat(page, peer) {
  await page.type(".chat-search-row input", peer);
  await page.evaluate(() => document.querySelector(".chat-search-row").requestSubmit());
  await page.waitForSelector('button[aria-label="Attach file"]', { timeout: 45000 });
}

async function attach(page, file) {
  const input = await page.waitForSelector('button[aria-label="Attach file"] + input[type="file"]', { timeout: 10000 });
  await input.uploadFile(file);
}

(async () => {
  fs.mkdirSync(FILES, { recursive: true });

  const small = path.join(FILES, "notes.txt");
  fs.writeFileSync(small, "hello ".repeat(20000)); // ~120KB -> inline path
  const photo = path.join(FILES, "photo.bmp");
  makeBmp(photo, 900, 900); // ~2.4MB valid image -> attachment path, auto-downloaded
  const video = path.join(FILES, "clip.mp4");
  makeRandom(video, 4 * 1024 * 1024 + 777); // ~4MB -> tap to download
  const doc = path.join(FILES, "doc.bin");
  makeRandom(doc, 3 * 1024 * 1024 + 1234); // 4 chunks, for retry/tamper/expiry
  const huge = path.join(FILES, "huge.bin");
  makeRandom(huge, 101 * 1024 * 1024); // over the limit
  const hashOf = (f) => sha256(fs.readFileSync(f));

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox"],
  });
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok });
    log(ok ? "PASS" : "FAIL", name, detail);
  };

  try {
    const alice = await newUser(browser, "e2e_alice");
    const bob = await newUser(browser, "e2e_bob");
    await openChat(alice, "e2e_bob");
    await openChat(bob, "e2e_alice");

    const aliceChunkGets = [];
    alice.on("request", (r) => { if (r.method() === "GET" && /\/api\/attachments\/.+\/chunks\//.test(r.url())) aliceChunkGets.push(r.url()); });

    const bobBubbles = () => bob.evaluate(() => document.querySelectorAll(".bubble-row.in").length);
    const waitForBobBubbles = (n, ms = 300000) => bob.waitForFunction((count) => document.querySelectorAll(".bubble-row.in").length >= count, { timeout: ms }, n);
    const stripText = () => alice.evaluate(() => document.querySelector(".transfer-strip")?.innerText.replace(/\n+/g, " | ") || "");
    // Downloads a file bob's page has already been made to click, verifying its
    // decrypted bytes directly rather than touching the filesystem (see the
    // interception installed in newUser). `already` is how many downloads
    // window.__downloads held before this click, so this grabs the new one.
    async function verifyDownloaded(already, expectedBuf) {
      await bob.waitForFunction((n) => window.__downloads.length > n, { timeout: 60000 }, already);
      return bob.evaluate(async (index) => {
        const d = window.__downloads[index];
        const buf = await (await fetch(d.href)).arrayBuffer();
        const digest = await crypto.subtle.digest("SHA-256", buf);
        return { name: d.name, bytes: buf.byteLength, hash: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("") };
      }, already).then((got) => ({ ...got, matches: got.hash === sha256(expectedBuf) && got.bytes === expectedBuf.length }));
    }

    // ---------- 1. small file: still inline, still works ----------
    await attach(alice, small);
    await waitForBobBubbles(1);
    const smallCard = await bob.evaluate(() => document.querySelector(".file-card")?.innerText.replace(/\n+/g, " | ") || "");
    check("small file (inline path) arrives", /notes\.txt/.test(smallCard), smallCard);
    check("small file never showed an upload strip", (await stripText()) === "");

    // ---------- 2. large photo: encrypted chunk upload, auto-download, byte-exact ----------
    await attach(alice, photo);
    await alice.waitForFunction(() => document.querySelector(".transfer-strip"), { timeout: 20000 }).catch(() => {});
    const sawStrip = (await stripText()) !== "" || true; // strip may already be gone on a fast link
    await alice.screenshot({ path: path.join(OUT, "files-upload-alice.png") });
    await waitForBobBubbles(2);
    await bob.waitForFunction(() => { const i = document.querySelector(".file-image"); return i && i.complete && i.naturalWidth > 0; }, { timeout: 300000 });
    const imgInfo = await bob.evaluate(async () => {
      const img = document.querySelector(".file-image");
      const buf = await (await fetch(img.src)).arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", buf);
      return { w: img.naturalWidth, bytes: buf.byteLength, hash: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("") };
    });
    check("large photo appears on the receiver automatically", imgInfo.w === 900, `w=${imgInfo.w}`);
    check("photo is byte-for-byte identical after encrypt/upload/download/decrypt", imgInfo.hash === hashOf(photo) && imgInfo.bytes === fs.statSync(photo).size, `${imgInfo.bytes} bytes`);
    await sleep(500);
    check("upload strip clears once sent", (await stripText()) === "");
    check("sender's own bubble shows the photo without re-downloading it", (await alice.evaluate(() => { const i = document.querySelector(".bubble-row.out .file-image"); return !!(i && i.naturalWidth > 0); })) && aliceChunkGets.length === 0, `chunk GETs by sender: ${aliceChunkGets.length}`);
    await bob.screenshot({ path: path.join(OUT, "files-photo-bob.png") });

    // ---------- 3. 4MB file: shows a card, tap to download, exact bytes saved ----------
    await attach(alice, video);
    await waitForBobBubbles(3);
    await bob.waitForFunction(() => [...document.querySelectorAll(".file-card")].some((c) => /clip\.mp4/.test(c.innerText)), { timeout: 300000 });
    const videoCard = await bob.evaluate(() => [...document.querySelectorAll(".file-card")].find((c) => /clip\.mp4/.test(c.innerText))?.innerText.replace(/\n+/g, " | "));
    check("4MB file shows as a file card with its size (not auto-downloaded)", /4\.0 MB/.test(videoCard || ""), videoCard);
    const beforeVideoDownloads = await bob.evaluate(() => window.__downloads.length);
    await bob.evaluate(() => {
      const card = [...document.querySelectorAll(".file-card")].find((c) => /clip\.mp4/.test(c.innerText));
      card.querySelector('button[aria-label="Download file"]').click();
    });
    await sleep(700);
    const mid = await bob.evaluate(() => [...document.querySelectorAll(".file-card")].find((c) => /clip\.mp4/.test(c.innerText))?.innerText.replace(/\n+/g, " | "));
    await bob.screenshot({ path: path.join(OUT, "files-downloading-bob.png") });
    log("mid-download card:", mid);
    const videoDl = await verifyDownloaded(beforeVideoDownloads, fs.readFileSync(video));
    check("download hands the browser the file to save", videoDl.name === "clip.mp4", videoDl.name);
    check("saved 4MB file is byte-for-byte identical", videoDl.matches, `${videoDl.bytes} bytes`);

    // ---------- 4. transient server failure: chunk upload retries and succeeds ----------
    await alice.setRequestInterception(true);
    let failedOnce = false;
    const aliceHandler = (req) => {
      if (req.method() === "PUT" && /\/chunks\/1$/.test(req.url()) && !failedOnce) {
        failedOnce = true;
        req.respond({ status: 503, headers: CORS, body: "busy" });
      } else req.continue();
    };
    alice.on("request", aliceHandler);
    await attach(alice, doc);
    await waitForBobBubbles(4);
    alice.off("request", aliceHandler);
    await alice.setRequestInterception(false);
    check("a failed chunk was retried and the file still went through", failedOnce);

    // ---------- 5. tampered chunk is detected, then a clean retry works ----------
    await bob.setRequestInterception(true);
    let tamper = true;
    const bobHandler = async (req) => {
      const isChunk = req.method() === "GET" && /\/api\/attachments\/.+\/chunks\/1$/.test(req.url());
      if (!isChunk) return req.continue();
      if (tamper === true) {
        const headers = req.headers();
        const upstream = await fetch(req.url(), { headers: { Authorization: headers.authorization } });
        const body = Buffer.from(await upstream.arrayBuffer());
        body[body.length - 5] ^= 0xff; // flip bits inside the ciphertext
        return req.respond({ status: 200, headers: { ...CORS, "Content-Type": "application/octet-stream" }, body });
      }
      if (tamper === "expired") return req.respond({ status: 404, headers: CORS, body: "{}" });
      return req.continue();
    };
    bob.on("request", bobHandler);
    const clickDocDownload = () => bob.evaluate(() => {
      const card = [...document.querySelectorAll(".file-card")].find((c) => /doc\.bin/.test(c.innerText));
      card.querySelector('button[aria-label="Download file"]').click();
    });
    const beforeDocDownloads = await bob.evaluate(() => window.__downloads.length);
    await clickDocDownload();
    await bob.waitForFunction(() => [...document.querySelectorAll(".file-card")].some((c) => /doc\.bin/.test(c.innerText) && /damaged/i.test(c.innerText)), { timeout: 60000 }).catch(() => {});
    const dmg = await bob.evaluate(() => [...document.querySelectorAll(".file-card")].find((c) => /doc\.bin/.test(c.innerText))?.innerText.replace(/\n+/g, " | "));
    check("a tampered chunk is rejected with a clear message", /damaged/i.test(dmg || ""), dmg);
    check("...and nothing was saved", (await bob.evaluate(() => window.__downloads.length)) === beforeDocDownloads);

    // expired on the server
    tamper = "expired";
    await sleep(4500);
    await clickDocDownload();
    await bob.waitForFunction(() => [...document.querySelectorAll(".file-card")].some((c) => /doc\.bin/.test(c.innerText) && /expired|no longer available/i.test(c.innerText)), { timeout: 60000 }).catch(() => {});
    const exp = await bob.evaluate(() => [...document.querySelectorAll(".file-card")].find((c) => /doc\.bin/.test(c.innerText))?.innerText.replace(/\n+/g, " | "));
    check("an expired file says so instead of hanging", /expired|no longer available/i.test(exp || ""), exp);

    tamper = false;
    await sleep(4500);
    const beforeRetryDownloads = await bob.evaluate(() => window.__downloads.length);
    await clickDocDownload();
    const docDl = await verifyDownloaded(beforeRetryDownloads, fs.readFileSync(doc));
    check("retrying after the failures downloads the exact file", docDl.matches, `${docDl.bytes} bytes`);
    bob.off("request", bobHandler);
    await bob.setRequestInterception(false);

    // ---------- 6. cancel mid-upload ----------
    await alice.setRequestInterception(true);
    const slowHandler = async (req) => {
      if (req.method() === "PUT" && /\/chunks\//.test(req.url())) await sleep(1500);
      req.continue().catch(() => {});
    };
    alice.on("request", slowHandler);
    const bubblesBefore = await bobBubbles();
    await attach(alice, video);
    await alice.waitForSelector(".transfer-strip", { timeout: 20000 });
    await sleep(2500);
    await alice.screenshot({ path: path.join(OUT, "files-upload-progress-alice.png") });
    const progText = await stripText();
    check("upload strip shows live progress", /\d+%/.test(progText), progText);
    await alice.evaluate(() => document.querySelector('.transfer-strip button[aria-label="Cancel upload"]').click());
    await sleep(2500);
    alice.off("request", slowHandler);
    await alice.setRequestInterception(false);
    check("cancel clears the strip", (await stripText()) === "");
    check("composer is usable again after cancel", await alice.evaluate(() => !document.querySelector('button[aria-label="Attach file"]').disabled));
    await sleep(2000);
    check("a cancelled upload sends nothing", (await bobBubbles()) === bubblesBefore);

    // ---------- 7. over the size limit ----------
    await attach(alice, huge);
    await sleep(1500);
    const limitText = await alice.evaluate(() => document.querySelector(".attach-error")?.innerText || "");
    check("a file over the limit is refused with a clear message", /too large|100/i.test(limitText), limitText);
    check("...and nothing is uploaded for it", (await stripText()) === "");
  } catch (err) {
    check("harness ran without throwing", false, err.stack || err.message);
  } finally {
    await browser.close();
    for (const f of ["huge.bin", "clip.mp4"]) fs.rmSync(path.join(FILES, f), { force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
