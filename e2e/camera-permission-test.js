// Camera/mic permission handling: a prompt left unanswered, and every way getUserMedia can fail.
const puppeteer = require("puppeteer-core");
const path = require("path");

const BASE = process.env.E2E_BASE_URL || "http://localhost:3200";
const CHROME = process.env.E2E_CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = __dirname;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 393, height: 852, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await ctx.overridePermissions(BASE, ["microphone", "camera", "notifications"]);
    await page.evaluateOnNewDocument(() => {
      const origGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      window.__streams = [];
      window.__gum = { hold: false, error: null, releases: [], audioError: null };
      navigator.mediaDevices.getUserMedia = async (c) => {
        const g = window.__gum;
        if (c && c.video && g.error) throw new DOMException("simulated", g.error);
        if (c && c.audio && !c.video && g.audioError) throw new DOMException("simulated", g.audioError);
        if (c && c.video && g.hold) {
          // Sit on the "permission prompt" until the test releases it.
          await new Promise((res) => g.releases.push(res));
        }
        const s = await origGum(c);
        window.__streams.push(s);
        return s;
      };
    });
    page.click = async (sel) => {
      await page.waitForSelector(sel, { timeout: 15000 });
      await page.evaluate((s) => document.querySelector(s).click(), sel);
    };
    page.on("pageerror", (e) => log("PAGEERROR", e.message));

    await page.goto(`${BASE}/login`);
    await page.type('input[type="text"], input:not([type])', "e2e_alice");
    await page.type('input[type="password"]', "TestPass123!");
    await page.click('button[type="submit"]');
    await page.waitForSelector(".sidebar-brand-bar", { timeout: 90000 });
    await page.waitForSelector(".conn-dot.online", { timeout: 30000 });
    await page.type(".chat-search-row input", "e2e_bob");
    await page.evaluate(() => document.querySelector(".chat-search-row").requestSubmit());
    await page.waitForSelector('button[aria-label="Video call"]', { timeout: 45000 });
    log("logged in, chat open");

    const overlay = () => page.evaluate(() => document.querySelector(".call-screen")?.innerText.replace(/\n+/g, " | ") || "(no overlay)");
    const waitText = (re, ms = 10000) =>
      page.waitForFunction((src) => new RegExp(src, "i").test(document.querySelector(".call-screen")?.innerText || ""), { timeout: ms }, re.source).catch(() => {});
    const waitGone = (ms = 10000) => page.waitForFunction(() => !document.querySelector(".call-screen"), { timeout: ms }).catch(() => {});
    const liveTracks = () => page.evaluate(() => window.__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === "live").length);

    // ---- 1. prompt left unanswered ----
    await page.evaluate(() => { window.__gum.hold = true; });
    await page.click('button[aria-label="Video call"]');
    check("before the hint delay it just says Calling…", /Calling/.test(await overlay()), await overlay());
    await sleep(1500);
    const waiting = await overlay();
    check("screen says it's waiting for camera permission", /Waiting for camera permission/.test(waiting), waiting);
    check("screen explains to choose Allow", /Choose Allow/.test(waiting), waiting);
    await page.screenshot({ path: path.join(OUT, "perm-waiting.png") });

    // Hang up while the prompt is still open, then answer it late.
    await page.click('button[aria-label="End call"]');
    await sleep(800);
    check("hang-up during the prompt clears the call", (await overlay()) === "(no overlay)");
    await page.evaluate(() => { window.__gum.hold = false; window.__gum.releases.forEach((r) => r()); });
    await sleep(1500);
    check("camera is NOT left on after granting late", (await liveTracks()) === 0, `live tracks: ${await liveTracks()}`);
    check("no ghost call/error appears after the late grant", (await overlay()) === "(no overlay)", await overlay());

    // ---- 2. failure modes ----
    const cases = [
      ["NotAllowedError", /blocked|Settings/i, "camera blocked"],
      ["NotFoundError", /No camera found/i, "no camera"],
      ["NotReadableError", /being used by another app/i, "camera busy"],
    ];
    for (const [err, re, label] of cases) {
      await page.evaluate((e) => { window.__gum.error = e; }, err);
      await page.click('button[aria-label="Video call"]');
      await waitText(re);
      const t = await overlay();
      check(`${label}: clear message`, re.test(t) && /camera/i.test(t), t);
      if (err === "NotAllowedError") await page.screenshot({ path: path.join(OUT, "perm-blocked.png") });
      await waitGone();
      check(`${label}: call clears itself`, (await overlay()) === "(no overlay)");
    }

    // Camera fine but mic is the problem -> should say microphone, not camera.
    await page.evaluate(() => { window.__gum.error = "NotAllowedError"; window.__gum.audioError = "NotAllowedError"; });
    await page.click('button[aria-label="Video call"]');
    await waitText(/icrophone/);
    const mic = await overlay();
    check("mic blocked too: message names the microphone", /icrophone/.test(mic), mic);
    await waitGone();

    // Voice call with a blocked mic.
    await page.evaluate(() => { window.__gum.error = null; });
    await page.click('button[aria-label="Voice call"]');
    await waitText(/icrophone/);
    const vmic = await overlay();
    check("voice call with blocked mic: names the microphone", /icrophone/.test(vmic), vmic);
    await waitGone();

    const thread = await page.evaluate(() => document.querySelector(".chat-thread-col")?.innerText || "");
    check("calls that never rang leave no 'No answer' entry in the chat", !/No answer|Missed/.test(thread), thread.slice(-120));

    // Works again once permissions are fixed.
    await page.evaluate(() => { window.__gum.error = null; window.__gum.audioError = null; });
    await page.click('button[aria-label="Video call"]');
    await waitText(/offline|Ringing/, 15000);
    check("after fixing permissions the call proceeds normally", /Ringing|Calling|offline/.test(await overlay()) && !/camera|microphone|permission/i.test(await overlay()) , await overlay());
    await page.click('button[aria-label="End call"]');
    await sleep(1500);
  } catch (err) {
    check("harness ran without throwing", false, err.stack || err.message);
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
