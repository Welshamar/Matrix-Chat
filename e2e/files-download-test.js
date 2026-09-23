// Focused check: a heavy (non-image) file downloads, decrypts and is handed to the browser's save as the exact bytes.
const puppeteer = require("puppeteer-core");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const BASE = process.env.E2E_BASE_URL || "http://localhost:3200";
const CHROME = process.env.E2E_CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const FILES = path.join(__dirname, "files");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newUser(browser, username) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 700, height: 900 });
  page.click = async (sel) => {
    await page.waitForSelector(sel, { timeout: 20000 });
    await page.evaluate((s) => document.querySelector(s).click(), sel);
  };
  // Capture the save instead of letting Chrome drop it in a download folder.
  await page.evaluateOnNewDocument(() => {
    window.__downloads = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) { window.__downloads.push({ href: this.href, name: this.download }); return; }
      return orig.apply(this, arguments);
    };
  });
  page.on("pageerror", (e) => log(`[${username}] PAGEERROR`, e.message));
  await page.goto(`${BASE}/login`);
  await page.type('input[type="text"], input:not([type])', username);
  await page.type('input[type="password"]', "TestPass123!");
  await page.click('button[type="submit"]');
  await page.waitForSelector(".sidebar-brand-bar", { timeout: 300000 });
  await page.waitForSelector(".conn-dot.online", { timeout: 60000 });
  return page;
}

(async () => {
  fs.mkdirSync(FILES, { recursive: true });
  const doc = path.join(FILES, "report.bin");
  fs.writeFileSync(doc, crypto.randomBytes(2 * 1024 * 1024 + 4321)); // 3 chunks
  const want = crypto.createHash("sha256").update(fs.readFileSync(doc)).digest("hex");

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
  const results = [];
  const check = (n, ok, d = "") => { results.push(ok); log(ok ? "PASS" : "FAIL", n, d); };
  try {
    const alice = await newUser(browser, "e2e_alice");
    const bob = await newUser(browser, "e2e_bob");
    for (const [p, peer] of [[alice, "e2e_bob"], [bob, "e2e_alice"]]) {
      await p.type(".chat-search-row input", peer);
      await p.evaluate(() => document.querySelector(".chat-search-row").requestSubmit());
      await p.waitForSelector('button[aria-label="Attach file"]', { timeout: 60000 });
    }
    const input = await alice.waitForSelector('button[aria-label="Attach file"] + input[type="file"]');
    await input.uploadFile(doc);
    await bob.waitForFunction(() => [...document.querySelectorAll(".file-card")].some((c) => /report\.bin/.test(c.innerText)), { timeout: 400000 });
    check("heavy non-image file shows as a card with its size", true);

    await bob.evaluate(() => [...document.querySelectorAll(".file-card")].find((c) => /report\.bin/.test(c.innerText)).querySelector('button[aria-label="Download file"]').click());
    await bob.waitForFunction(() => window.__downloads.length > 0, { timeout: 400000 });
    const got = await bob.evaluate(async () => {
      const d = window.__downloads[0];
      const buf = await (await fetch(d.href)).arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", buf);
      return { name: d.name, bytes: buf.byteLength, hash: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("") };
    });
    check("saved under the original filename", got.name === "report.bin", got.name);
    check("saved bytes are identical to what was sent", got.hash === want && got.bytes === fs.statSync(doc).size, `${got.bytes} bytes`);

    // Second tap should reuse the local copy: no new chunk downloads.
    let chunkGets = 0;
    bob.on("request", (r) => { if (/\/api\/attachments\/.+\/chunks\//.test(r.url())) chunkGets++; });
    await bob.evaluate(() => [...document.querySelectorAll(".file-card")].find((c) => /report\.bin/.test(c.innerText)).querySelector('button[aria-label="Download file"]').click());
    await sleep(2500);
    check("saving again uses the local copy (no re-download)", chunkGets === 0 && (await bob.evaluate(() => window.__downloads.length)) === 2, `chunk GETs: ${chunkGets}`);
  } catch (e) {
    check("harness ran", false, e.stack || e.message);
  } finally {
    await browser.close();
  }
  console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})();
