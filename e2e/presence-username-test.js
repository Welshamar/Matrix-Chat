// Online/offline presence, and the widened username rule (any characters
// except emoji, spaces allowed).
const puppeteer = require("puppeteer-core");
const crypto = require("crypto");

const BASE = process.env.E2E_BASE_URL || "http://localhost:3200";
const CHROME = process.env.E2E_CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newContext(browser) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 700, height: 900 });
  page.click = async (sel) => {
    await page.waitForSelector(sel, { timeout: 20000 });
    await page.evaluate((s) => document.querySelector(s).click(), sel);
  };
  page.on("pageerror", (e) => log("PAGEERROR", e.message));
  return page;
}

async function login(page, username) {
  await page.goto(`${BASE}/login`);
  await page.type('input[type="text"], input:not([type])', username);
  await page.type('input[type="password"]', "TestPass123!");
  await page.click('button[type="submit"]');
  await page.waitForSelector(".sidebar-brand-bar", { timeout: 90000 });
  await page.waitForSelector(".conn-dot.online", { timeout: 30000 });
  log(`[${username}] logged in`);
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
  const results = [];
  const check = (n, ok, d = "") => { results.push(ok); log(ok ? "PASS" : "FAIL", n, d); };
  let regPage = null;
  try {
    // ---------- username validation ----------
    regPage = await newContext(browser);
    await regPage.goto(`${BASE}/register`);

    const spacedName = `E2E Space Name ${crypto.randomBytes(3).toString("hex")}`;
    await regPage.type("#username", spacedName);
    await regPage.type("#email", `e2e-space-${Date.now()}@example.invalid`);
    await regPage.type("#password", "TestPass123!");
    await regPage.click('button[type="submit"]');
    await sleep(1500);
    // Real email delivery (Resend) may or may not actually succeed for a
    // fake @example.invalid address -- what this proves is narrower and
    // doesn't depend on that: the username itself was never the problem.
    const spacedErr = await regPage.evaluate(() => document.querySelector(".error-banner")?.innerText || "");
    check("a username with spaces is never rejected for its characters", !/username/i.test(spacedErr), spacedErr || "(no error)");

    // reload back to a fresh register form for the emoji case
    await regPage.goto(`${BASE}/register`);
    await regPage.type("#username", `E2E Emoji 😀`);
    await regPage.type("#email", `e2e-emoji-${Date.now()}@example.invalid`);
    await regPage.type("#password", "TestPass123!");
    await regPage.click('button[type="submit"]');
    await sleep(800);
    const emojiError = await regPage.evaluate(() => document.querySelector(".error-banner")?.innerText || "");
    check("a username with an emoji is rejected with a clear message", /emoji/i.test(emojiError), emojiError);

    await regPage.goto(`${BASE}/register`);
    await regPage.type("#username", "E2"); // under the 3-char minimum
    await regPage.type("#email", `e2e-short-${Date.now()}@example.invalid`);
    await regPage.type("#password", "TestPass123!");
    await regPage.click('button[type="submit"]');
    await sleep(800);
    // Blocked either by the input's own minLength or the JS check -- either
    // way the form must not have gone anywhere (still on the register form,
    // not the verify-code step).
    const stillOnForm = await regPage.evaluate(() => !!document.querySelector("#username"));
    check("a too-short username is still rejected", stillOnForm);

    // ---------- presence ----------
    const alice = await newContext(browser);
    await login(alice, "e2e_alice");
    await alice.type(".chat-search-row input", "e2e_bob");
    await alice.evaluate(() => document.querySelector(".chat-search-row").requestSubmit());
    await alice.waitForSelector('button[aria-label="Voice call"]', { timeout: 45000 });
    await sleep(1000);

    const headerStatus = () => alice.evaluate(() => document.querySelector(".lock")?.innerText || "");
    const beforeBobOnline = await headerStatus();
    check("before bob logs in, header does not falsely say online", !/^online$/.test(beforeBobOnline), beforeBobOnline);
    log("header before bob:", beforeBobOnline);

    const bob = await newContext(browser);
    await login(bob, "e2e_bob");
    await alice.waitForFunction(() => document.querySelector(".lock")?.innerText === "online", { timeout: 20000 }).catch(() => {});
    const afterBobOnline = await headerStatus();
    check("header shows 'online' live the moment bob connects", afterBobOnline === "online", afterBobOnline);

    const dotVisible = await alice.evaluate(() => !!document.querySelector(".chat-header-clickable .avatar-online-dot"));
    check("header avatar shows the green online dot", dotVisible);

    // sidebar dot: back to the list (the header unmounts here -- only the
    // list's own row is under test for this one), then straight back into
    // bob's chat so the header checks below have something to read again.
    await alice.evaluate(() => document.querySelector(".chat-back-btn")?.click());
    await sleep(500);
    const sidebarDot = await alice.evaluate(() => !!document.querySelector(".conversation-item .avatar-online-dot"));
    check("sidebar conversation row also shows the online dot", sidebarDot);
    await alice.evaluate(() => document.querySelector(".conversation-item")?.click());
    await sleep(500);

    // bob logs out (closes his context entirely, simulating going offline)
    const bobCtx = bob.browserContext();
    await bobCtx.close();
    await alice.waitForFunction(() => document.querySelector(".lock")?.innerText && document.querySelector(".lock")?.innerText !== "online", { timeout: 20000 }).catch(() => {});
    await sleep(1000);
    const afterBobOffline = await headerStatus();
    check("header updates live once bob disconnects (no longer 'online')", afterBobOffline !== "online" && afterBobOffline !== "", afterBobOffline);
    check("offline state shows a 'last seen' phrasing", /last seen/i.test(afterBobOffline), afterBobOffline);
  } catch (err) {
    check("harness ran without throwing", false, err.stack || err.message);
  } finally {
    await browser.close();
  }
  console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})();
