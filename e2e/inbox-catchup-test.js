// Messages sent while the recipient's socket is down must show up without a
// full app restart: on socket reconnect, and on returning to the foreground
// (even if the socket itself is still down).
const puppeteer = require("puppeteer-core");

const BASE = process.env.E2E_BASE_URL || "http://localhost:3200";
const CHROME = process.env.E2E_CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 20000, step = 250) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(step);
  }
  return false;
};

async function newUser(browser, username) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.evaluateOnNewDocument(() => {
    const OrigWS = window.WebSocket;
    window.__wss = [];
    window.__blockWs = false;
    window.WebSocket = function (...args) {
      const ws = window.__blockWs ? new OrigWS("ws://localhost:1/") : new OrigWS(...args);
      window.__wss.push(ws);
      return ws;
    };
    window.WebSocket.prototype = OrigWS.prototype;
    for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) window.WebSocket[k] = OrigWS[k];
  });
  await page.goto(`${BASE}/login`);
  await page.type('input[type="text"], input:not([type])', username);
  await page.type('input[type="password"]', "TestPass123!");
  await page.click('button[type="submit"]');
  await page.waitForSelector(".sidebar-brand-bar", { timeout: 300000 });
  await page.waitForSelector(".conn-dot.online", { timeout: 60000 });
  page.on("console", (m) => { if (m.type() === "error" && !/WebSocket|favicon|ERR_FAILED|ERR_CONNECTION/.test(m.text())) log(`[${username}] console.error`, m.text().slice(0, 300)); });
  page.on("response", async (r) => { if (/\/api\/messages\/inbox/.test(r.url())) { let n = "?"; try { n = (await r.json()).length; } catch {} log(`[${username}] inbox ${r.status()} -> ${n} msgs`); } });
  log(`[${username}] logged in`);
  return page;
}

const bubbleTexts = (p) => p.evaluate(() => [...document.querySelectorAll(".bubble.in")].map((b) => b.innerText.replace(/\s+/g, " ").trim()));
const count = async (p, text) => (await bubbleTexts(p)).filter((t) => t.includes(text)).length;
const dropSocket = (p) => p.evaluate(() => { window.__blockWs = true; window.__wss.forEach((w) => { try { w.close(); } catch {} }); });
const restoreSocket = (p) => p.evaluate(() => { window.__blockWs = false; });
const sendFrom = async (p, text) => {
  await p.type(".composer-input-pill input:not([type=file])", text);
  await p.keyboard.press("Enter");
};

(async () => {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push(ok);
    log(ok ? "PASS" : "FAIL", name, ok ? "" : detail);
  };
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox"],
  });
  try {
    const alice = await newUser(browser, "e2e_alice");
    const bob = await newUser(browser, "e2e_bob");

    await alice.type(".chat-search-row input", "e2e_bob");
    await alice.evaluate(() => document.querySelector(".chat-search-row").requestSubmit());
    await alice.waitForSelector(".composer-input-pill input:not([type=file])");
    await sendFrom(alice, "warmup");
    await waitFor(() => bob.evaluate(() => !!document.querySelector(".conversation-item")));
    await bob.evaluate(() => document.querySelector(".conversation-item").click());
    check("baseline: live delivery works", !!(await waitFor(async () => (await count(bob, "warmup")) === 1)));

    // --- Scenario 1: socket drops, message sent, socket comes back ---
    await dropSocket(bob);
    check("bob's socket is down", !!(await waitFor(() => bob.evaluate(() => !document.querySelector(".conn-dot.online")), 15000)));
    await sendFrom(alice, "while-offline-1");
    await sleep(1500);
    check("message does not arrive while the socket is down", (await count(bob, "while-offline-1")) === 0);
    await restoreSocket(bob);
    check("after reconnect the missed message appears (no reload)", !!(await waitFor(async () => (await count(bob, "while-offline-1")) === 1, 30000)));

    // --- Scenario 2: foreground resume with the socket still down ---
    await dropSocket(bob);
    await waitFor(() => bob.evaluate(() => !document.querySelector(".conn-dot.online")), 15000);
    await sendFrom(alice, "while-offline-2");
    await sleep(1000);
    await bob.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    check("returning to the foreground fetches the missed message even with the socket down", !!(await waitFor(async () => (await count(bob, "while-offline-2")) === 1, 15000)));

    // --- Live path still works and nothing was duplicated ---
    await restoreSocket(bob);
    await waitFor(() => bob.evaluate(() => !!document.querySelector(".conn-dot.online")), 30000);
    await sendFrom(alice, "live-after");
    check("live delivery works again after recovery", !!(await waitFor(async () => (await count(bob, "live-after")) === 1, 15000)));
    await sleep(2000);
    const dupes = (await Promise.all(["warmup", "while-offline-1", "while-offline-2", "live-after"].map((t) => count(bob, t)))).every((n) => n === 1);
    check("no message appears twice", dupes);
  } catch (e) {
    check("harness ran without throwing", false, e.message);
  } finally {
    await browser.close();
  }
  console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})();
