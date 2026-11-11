import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

const require = createRequire(
  pathToFileURL(path.join(process.cwd(), "pwd/package.json")).href
);
const { chromium } = require("./pwd/node_modules/playwright");

const urls = process.argv.slice(2);
const browser = await chromium.launch({
  headless: true,
  args: ["--disable-blink-features=AutomationControlled"],
});
const context = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  locale: "en-US",
  viewport: { width: 1280, height: 800 },
});
await context.addInitScript(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
});

for (const url of urls) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    const start = Date.now();
    let title = await page.title();
    while (
      /checking your browser|just a moment/i.test(title) &&
      Date.now() - start < 25000
    ) {
      await page.waitForTimeout(1500);
      title = await page.title();
    }
    const body = await page.evaluate(() => document.body?.innerText?.slice(0, 800) || "");
    console.log(
      JSON.stringify(
        { url, finalUrl: page.url(), title, body: body.slice(0, 300) },
        null,
        2
      )
    );
  } catch (e) {
    console.log(JSON.stringify({ url, error: e.message }));
  } finally {
    await page.close();
  }
}
await browser.close();
