// Broad regression: login, unread badges, read receipts, typing indicators, voice-note recording (hold-release/lock/pause/cancel), file-card send/receive, reply, delete-for-me, and chat-list resilience when the network is down.
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");

const BASE = process.env.E2E_BASE_URL || "http://localhost:3200";
const CHROME = process.env.E2E_CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newUser(browser, username) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await ctx.overridePermissions(BASE, ["microphone", "notifications"]);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => { if (m.type() === "error" && !/WebSocket/.test(m.text())) log("[" + username + "] console.error:", m.text().slice(0, 300)); }); page.on("response", (r) => { if (r.status() >= 400) log("[" + username + "] HTTP", r.status(), r.url()); });
  page.errors = errors;
  await page.goto(`${BASE}/login`);
  await page.type('input[type="text"], input:not([type])', username);
  await page.type('input[type="password"]', "TestPass123!");
  await page.click('button[type="submit"]');
  await page.waitForSelector(".sidebar-brand-bar", { timeout: 60000 });
  await page.waitForSelector(".conn-dot.online", { timeout: 30000 });
  return page;
}

const dis = (p) => p.evaluate(() => document.querySelector('.composer-input-pill input:not([type=file])')?.disabled);
const bubbles = (p) => p.evaluate(() => [...document.querySelectorAll(".bubble")].map((b) => ({ cls: b.className, text: b.innerText.replace(/\s+/g, " ").trim() })));
const headerStatus = (p) => p.evaluate(() => document.querySelector(".chat-header .lock")?.innerText || "");
const waitFor = async (fn, ms = 15000, step = 250) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(step);
  }
  return false;
};

(async () => {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok });
    log(ok ? "PASS" : "FAIL", name, ok ? "" : detail);
  };

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--no-sandbox"],
  });

  try {
    const alice = await newUser(browser, "e2e_alice");
    const bob = await newUser(browser, "e2e_bob");

    // ---------- Branding ----------
    const brand = await alice.evaluate(() => {
      const img = document.querySelector(".sidebar-brand-logo");
      return { hasImg: !!img, loaded: !!img && img.complete && img.naturalWidth > 0, name: document.querySelector(".sidebar-brand-name")?.innerText };
    });
    check("sidebar shows Matrix Chat brand with logo mark", brand.hasImg && brand.loaded && brand.name === "Matrix Chat", JSON.stringify(brand));
    const icon = await alice.evaluate(() => fetch("/icon.png").then((r) => r.status + " " + r.headers.get("content-type")));
    check("favicon /icon.png is served as PNG", icon.startsWith("200 image/png"), icon);

    // ---------- Open chat ----------
    await alice.type(".chat-search-row input", "e2e_bob");
    await alice.evaluate(() => document.querySelector(".chat-search-row").requestSubmit());
    await alice.waitForSelector(".composer-input-pill input:not([type=file])");

    // ---------- Text messaging + E2E delivery ----------
    await alice.type(".composer-input-pill input:not([type=file])", "hello bob, from alice");
    await alice.keyboard.press("Enter");
    check("alice's sent message appears in her thread", !!(await waitFor(async () => (await bubbles(alice)).some((b) => b.text.includes("hello bob, from alice")))));

    // Bob gets a conversation entry (decrypted preview, not ciphertext) and unread badge.
    const bobRow = await waitFor(() => bob.evaluate(() => document.querySelector(".conversation-item")?.innerText.replace(/\s+/g, " ")));
    check("bob's sidebar shows alice with decrypted preview", !!bobRow && bobRow.includes("hello bob, from alice"), String(bobRow));
    check("bob's sidebar shows unread badge", !!(await waitFor(() => bob.evaluate(() => !!document.querySelector(".unread-badge")), 10000)));

    await bob.click(".conversation-item");
    await bob.waitForSelector(".composer-input-pill input:not([type=file])");
    check("bob sees the message bubble after opening thread", !!(await waitFor(async () => (await bubbles(bob)).some((b) => b.cls.includes(" in") && b.text.includes("hello bob, from alice")))));
    check("opening the thread clears bob's unread badge", !!(await waitFor(() => bob.evaluate(() => !document.querySelector(".unread-badge")))));
    check("alice's message ticks turn blue (read receipt)", !!(await waitFor(() => alice.evaluate(() => !!document.querySelector(".bubble.out .tick-read")))));

    // Reverse direction + reply.
    await bob.type(".composer-input-pill input:not([type=file])", "hi alice, got it");
    await bob.keyboard.press("Enter");
    check("alice receives bob's reply in real time", !!(await waitFor(async () => (await bubbles(alice)).some((b) => b.cls.includes(" in") && b.text.includes("hi alice, got it")))));

    // ---------- Typing indicator ----------
    await bob.type(".composer-input-pill input:not([type=file])", "typing something");
    const sawTyping = await waitFor(async () => /typing/i.test(await headerStatus(alice)), 6000);
    check("alice sees 'typing...' in header while bob types", !!sawTyping, await headerStatus(alice));
    check("alice's sidebar preview shows typing too", await alice.evaluate(() => /typing/i.test(document.querySelector(".conversation-item .preview")?.innerText || "")));
    const cleared = await waitFor(async () => !/typing/i.test(await headerStatus(alice)), 9000);
    check("typing indicator clears after bob stops", !!cleared, await headerStatus(alice));
    // clear bob's draft
    await bob.click(".composer-input-pill input:not([type=file])", { clickCount: 3 });
    await bob.keyboard.press("Backspace");

    // ---------- Voice recorder: hold + release sends ----------
    const mic = await alice.$(".voice-mic-btn");
    const box = await mic.boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await alice.mouse.move(cx, cy);
    await alice.mouse.down();
    const barShown = await waitFor(() => alice.evaluate(() => !!document.querySelector(".voice-recording-bar")), 5000);
    check("holding mic shows the recording bar", !!barShown);
    await sleep(1800);
    await alice.mouse.up();
    check("bob receives the hold-and-release voice note", !!(await waitFor(() => bob.evaluate(() => !!document.querySelector(".voice-msg")), 15000)));
    log("DEBUG composer disabled after hold-release note (t+0):", await dis(alice)); await sleep(3000); log("DEBUG composer disabled 3s later:", await dis(alice));
    check("recording bar closes after release", await alice.evaluate(() => !document.querySelector(".voice-recording-bar")));

    // ---------- Voice recorder: drag up to lock, pause, send ----------
    const mic2 = await alice.$(".voice-mic-btn");
    const b2 = await mic2.boundingBox();
    const x2 = b2.x + b2.width / 2, y2 = b2.y + b2.height / 2;
    await alice.mouse.move(x2, y2);
    await alice.mouse.down();
    await sleep(500);
    await alice.mouse.move(x2, y2 - 90, { steps: 8 });
    const locked = await waitFor(() => alice.evaluate(() => !!document.querySelector(".voice-locked-send")), 4000);
    check("dragging up locks recording (send button appears)", !!locked);
    await alice.mouse.up();
    await sleep(1200);
    check("locked recording stays active after finger release", await alice.evaluate(() => !!document.querySelector(".voice-recording-bar")));
    await alice.click(".voice-locked-pause");
    const t1 = await alice.evaluate(() => document.querySelector(".voice-recording-time")?.innerText);
    await sleep(2200);
    const t2 = await alice.evaluate(() => document.querySelector(".voice-recording-time")?.innerText);
    check("timer freezes while paused", t1 === t2, `${t1} -> ${t2}`);
    await alice.click(".voice-locked-pause");
    await sleep(600);
    await alice.click(".voice-locked-send");
    await waitFor(() => bob.evaluate(() => document.querySelectorAll(".voice-msg").length >= 2), 15000);
    log("DEBUG composer disabled after locked note:", await dis(alice));
    check("bob receives the locked voice note (2 total)", await bob.evaluate(() => document.querySelectorAll(".voice-msg").length >= 2));

    // ---------- Voice recorder: slide left cancels ----------
    const before = await bob.evaluate(() => document.querySelectorAll(".voice-msg").length);
    const mic3 = await alice.$(".voice-mic-btn");
    const b3 = await mic3.boundingBox();
    const x3 = b3.x + b3.width / 2, y3 = b3.y + b3.height / 2;
    await alice.mouse.move(x3, y3);
    await alice.mouse.down();
    await sleep(800);
    await alice.mouse.move(x3 - 140, y3, { steps: 8 });
    await alice.mouse.up();
    await sleep(3000);
    log("DEBUG composer disabled after cancel:", await dis(alice));
    check("sliding left cancels (nothing sent)", (await bob.evaluate(() => document.querySelectorAll(".voice-msg").length)) === before);

    // ---------- File card ----------
    const apk = path.join(__dirname, "app-debug.apk");
    fs.writeFileSync(apk, Buffer.alloc(150000, 7));
    alice.on("console", (m) => log("ALICE console", m.type(), m.text().slice(0, 250)));
    alice.on("requestfailed", (r) => log("ALICE requestfailed", r.url()));
    log("DEBUG before upload, composer disabled:", await dis(alice), "| alice file input disabled:", await alice.evaluate(() => document.querySelector('input[type="file"]')?.disabled));
    const fileInput = await alice.$('input[type="file"]');
    await fileInput.uploadFile(apk);
    for (const ms of [500, 2000, 6000]) { await sleep(ms); log("DEBUG +" + ms + "ms composer disabled:", await dis(alice)); }
    const card = await waitFor(() => bob.evaluate(() => {
      const c = document.querySelector(".file-card");
      if (!c) return null;
      return {
        badge: c.querySelector(".file-card-badge")?.innerText,
        badgeCls: c.querySelector(".file-card-badge")?.className,
        name: c.querySelector(".file-card-name")?.innerText,
        size: c.querySelector(".file-card-size")?.innerText,
        share: !!c.querySelector('[aria-label="Share file"]'),
        download: !!c.querySelector('[aria-label="Download file"]'),
      };
    }), 90000);
    if (!card) {
      log("DEBUG alice bubbles:", JSON.stringify((await bubbles(alice)).slice(-3)));
      log("DEBUG bob bubbles:", JSON.stringify((await bubbles(bob)).slice(-3)));
      log("DEBUG alice file input disabled:", await alice.evaluate(() => document.querySelector('input[type="file"]')?.disabled));
    }
    check("bob receives file card with APK badge, name and size", !!card && card.badge === "APK" && card.badgeCls.includes("file-badge-apk") && card.name === "app-debug.apk" && /KB/.test(card.size), JSON.stringify(card));
    check("file card has share and download buttons", !!card && card.share && card.download, JSON.stringify(card));
    await bob.click('.file-card [aria-label="Share file"]');
    await bob.click('.file-card [aria-label="Download file"]');
    await sleep(500);
    check("share/download clicks don't throw", bob.errors.length === 0, bob.errors.join(" | "));

    // ---------- Reply & delete-for-me ----------
    const countIn = () => bob.evaluate(() => document.querySelectorAll(".bubble").length);
    const n0 = await countIn();
    await bob.hover(".bubble.in");
    await bob.click(".bubble.in [aria-label='Message options']");
    await bob.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.innerText.trim() === "Reply")?.click());
    check("reply shows the quoted-reply preview bar", !!(await waitFor(() => bob.evaluate(() => !!document.querySelector(".reply-preview-bar")), 5000)));
    await bob.click(".reply-preview-close");
    await bob.hover(".bubble.in");
    await bob.click(".bubble.in [aria-label='Message options']");
    await bob.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.innerText.trim() === "Delete")?.click());
    check("delete-for-me removes exactly one bubble locally", !!(await waitFor(async () => (await countIn()) === n0 - 1, 8000)), `${n0} -> ${await countIn()}`);
    check("...but the sender's copy is untouched", (await alice.evaluate(() => document.querySelectorAll(".bubble").length)) >= n0);

    // ---------- Offline-first chat list ----------
    const bobPage2 = await (async () => {
      await bob.setRequestInterception(true);
      bob.on("request", (req) => {
        if (/\/api\/(messages\/inbox|groups)/.test(req.url())) req.abort();
        else req.continue();
      });
      await bob.reload();
      return bob;
    })();
    const t0 = Date.now();
    const listShown = await waitFor(() => bobPage2.evaluate(() => document.querySelectorAll(".conversation-item").length > 0), 20000, 100);
    check("chat list renders from local cache even when inbox/groups requests fail", !!listShown, `after ${Date.now() - t0}ms`);
    const stillUp = await bobPage2.evaluate(() => !document.querySelector(".loading-screen"));
    check("no full-screen error after failed inbox fetch", stillUp);

    // ---------- Page errors ----------
    check("no uncaught page errors (alice)", alice.errors.length === 0, alice.errors.join(" | "));
    check("no uncaught page errors (bob)", bob.errors.length === 0, bob.errors.join(" | "));
    fs.unlinkSync(apk);
  } catch (err) {
    check("harness ran without throwing", false, err.stack.split("\n").slice(0, 3).join(" "));
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
