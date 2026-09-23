// Message delivery/read tick states (sent / delivered / read) update correctly on both sides.
const puppeteer = require("puppeteer-core");
const BASE = process.env.E2E_BASE_URL || "http://localhost:3200";
const CHROME = process.env.E2E_CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const waitFor = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch {} await sleep(250); } return false; };

async function login(browser, u) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.goto(BASE + "/login");
  await p.type('input[type="text"], input:not([type])', u);
  await p.type('input[type="password"]', "TestPass123!");
  await p.click('button[type="submit"]');
  await p.waitForSelector(".conn-dot.online", { timeout: 90000 });
  return p;
}
const INPUT = ".composer-input-pill input:not([type=file])";
const lastOutTicks = (p) => p.evaluate(() => { const o = [...document.querySelectorAll(".bubble.out")].pop(); return o ? o.querySelector(".tick")?.className + "|" + o.querySelector(".tick")?.innerText : null; });

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
  let pass = 0, fail = 0;
  const check = (n, ok, d = "") => { ok ? pass++ : fail++; log(ok ? "PASS" : "FAIL", n, ok ? "" : d); };
  try {
    const alice = await login(browser, "e2e_alice");
    const bob = await login(browser, "e2e_bob");
    await alice.type(".chat-search-row input", "e2e_bob");
    await alice.evaluate(() => document.querySelector(".chat-search-row").requestSubmit());
    await alice.waitForSelector(INPUT);
    await alice.type(INPUT, "first"); await alice.keyboard.press("Enter");
    await waitFor(() => bob.evaluate(() => !!document.querySelector(".unread-badge")), 30000);
    await bob.click(".conversation-item");
    await bob.waitForSelector(INPUT);
    await sleep(3000);

    // Bob is looking at the thread. Now Alice sends three more, back to back.
    for (const t of ["second", "third", "fourth"]) {
      await waitFor(() => alice.evaluate((sel) => !document.querySelector(sel)?.disabled, INPUT), 60000);
      await alice.type(INPUT, t); await alice.keyboard.press("Enter");
      await waitFor(() => alice.evaluate((txt) => [...document.querySelectorAll(".bubble.out")].some((b) => b.innerText.includes(txt)), t), 60000);
    }
    await waitFor(() => bob.evaluate(() => [...document.querySelectorAll(".bubble.in")].some((b) => b.innerText.includes("fourth"))), 60000);
    await sleep(6000); // let every receipt land, in whatever order

    const all = await alice.evaluate(() => [...document.querySelectorAll(".bubble.out")].map((b) => (b.querySelector(".tick")?.className.includes("tick-read") ? "READ" : "grey:" + b.querySelector(".tick")?.innerText)));
    log("sender's tick states:", JSON.stringify(all));
    check("every message sent while the thread was open shows blue (read) ticks", all.length === 4 && all.every((x) => x === "READ"), JSON.stringify(all));
  } catch (e) { check("harness ran", false, e.message); }
  await browser.close();
  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail ? 1 : 0);
})();
