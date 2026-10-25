/**
 * Per-site version picker in the web app, and browser parity with the pinned
 * vectors in scripts/test-derive.mjs.
 *
 *   node scripts/test-site-version.mjs
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const types = { html: "text/html; charset=utf-8", css: "text/css", js: "text/javascript", json: "application/json", png: "image/png" };
const server = createServer((req, res) => {
  let path = req.url.split("?")[0];
  if (!path.startsWith("/pwd/")) {
    res.writeHead(404);
    res.end();
    return;
  }
  path = path.slice("/pwd/".length) || "index.html";
  try {
    const body = readFileSync(join(root, path));
    res.writeHead(200, { "Content-Type": types[path.split(".").pop()] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, resolve));
const url = `http://localhost:${server.address().port}/pwd/`;

const AMAZON_V1 = "EhQD!pe0yi80VsnVt";
const AMAZON_V2 = "08MQKwQCHVr!F1sdJ";
const WELLS_V1 = "lS7o!ftVoC7aSzYEH";

let failures = 0;
function check(condition, message) {
  console.log(`  ${condition ? "ok  " : "FAIL"} ${message}`);
  if (!condition) failures += 1;
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 420, height: 860 } });
const page = await context.newPage();

async function load() {
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => Boolean(globalThis.hashwasm?.argon2id));
  await page.waitForTimeout(300);
}

async function setPhrase(text) {
  await page.click("#phrase");
  await page.keyboard.type(text);
}

async function setSite(text) {
  await page.fill("#site", "");
  await page.click("#site");
  await page.keyboard.type(text, { delay: 20 });
}

async function password() {
  await page.waitForFunction(() => {
    const el = document.querySelector("#password");
    return !document.querySelector("#result").hidden && el.textContent.length === 17 && !el.classList.contains("pending");
  }, null, { timeout: 30000 });
  await page.waitForTimeout(150);
  return page.locator("#password").textContent();
}

async function waitForPassword(expected) {
  await page.waitForFunction((want) => document.querySelector("#password").textContent === want, expected, { timeout: 30000 })
    .catch(() => {});
  return page.locator("#password").textContent();
}

const label = () => page.locator("#version").textContent();
const menuItems = () => page.evaluate(() => [...document.querySelectorAll("#version-menu button")]
  .map((button) => `${button.textContent}${button.getAttribute("aria-selected") === "true" ? "*" : ""}`));

console.log("Layout");
await load();
check(await label() === "v1" && await page.locator("#version").isDisabled(), "shows v1, disabled until a site is entered");
const styles = await page.evaluate(() => {
  const pick = (el) => {
    const s = getComputedStyle(el);
    return { size: s.fontSize, color: s.color };
  };
  const site = document.querySelector(".site-label");
  const version = document.querySelector("#version");
  const field = document.querySelector("#site-field").getBoundingClientRect();
  const siteBox = site.getBoundingClientRect();
  const versionBox = version.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(version);
  const text = range.getBoundingClientRect();
  return {
    site: pick(site),
    version: pick(version),
    rightGap: field.right - text.right,
    centerDelta: Math.abs((siteBox.top + siteBox.bottom) / 2 - (versionBox.top + versionBox.bottom) / 2),
  };
});
check(styles.site.size === styles.version.size && styles.site.color === styles.version.color,
  `same font size and color as the Site label (${styles.version.size}, ${styles.version.color})`);
check(styles.rightGap > 12 && styles.rightGap < 20, `inset from the form's right edge like the label's left inset (${styles.rightGap.toFixed(1)}px)`);
check(styles.centerDelta < 1.5, `vertically centered with the Site label (off by ${styles.centerDelta.toFixed(2)}px)`);

console.log("Browser matches the pinned vectors");
await setPhrase("test-passphrase");
await setSite("amazon");
check(await password() === AMAZON_V1, "amazon v1");
check(await label() === "v1" && !(await page.locator("#version").isDisabled()), "label enabled at v1");

console.log("Dropdown");
await page.click("#version");
check(JSON.stringify(await menuItems()) === JSON.stringify(["v1current*", "v2new"]), `lists current and next (${(await menuItems()).join(", ")})`);
if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/version-menu.png` });
await page.locator("#version-menu button").nth(1).click();
check(await waitForPassword(AMAZON_V2) === AMAZON_V2, "choosing v2 gives the v2 password");
check(await label() === "v2" && await page.locator("#version-menu").isHidden(), "label shows v2 and the menu closed");

console.log("Remembered per site");
await setSite("wells fargo");
check(await waitForPassword(WELLS_V1) === WELLS_V1 && await label() === "v1", "another site stays on v1");
await load();
await setPhrase("test-passphrase");
await setSite("amazon");
check(await waitForPassword(AMAZON_V2) === AMAZON_V2 && await label() === "v2", "amazon is still v2 after reload");
await page.click("#version");
check(JSON.stringify(await menuItems()) === JSON.stringify(["v1", "v2current*", "v3new"]), `menu grows by one (${(await menuItems()).join(", ")})`);
await page.mouse.click(5, 5);
check(await page.locator("#version-menu").isHidden(), "clicking outside closes the menu");
await page.click("#version");
await page.locator("#version-menu button").nth(0).click();
check(await waitForPassword(AMAZON_V1) === AMAZON_V1 && await label() === "v1", "back to v1");
const stored = await page.evaluate(() => localStorage.getItem("hizPwdSiteVersions"));
check(stored === "{}", `v1 is not stored (${stored})`);

console.log("Slow network at launch");
const slow = await browser.newContext({ viewport: { width: 420, height: 860 }, serviceWorkers: "block" });
const slowPage = await slow.newPage();
await slowPage.route(/catalog\.json/, async (route) => {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await route.continue();
});
await slowPage.goto(url, { waitUntil: "domcontentloaded" });
await slowPage.click("#site");
await slowPage.keyboard.type("amazon", { delay: 400 });
const typed = await slowPage.evaluate(() => ({
  site: document.querySelector("#site").value,
  phrase: document.querySelector("#phrase").value,
}));
check(typed.site.toLowerCase() === "amazon" && typed.phrase === "",
  `focus stays in the site field while the catalog loads (${JSON.stringify(typed)})`);
await slow.close();

await browser.close();
server.close();
if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nsite version ok");
