#!/usr/bin/env node
/**
 * Follow soft-alive / bot-challenged URLs in headless Chromium and print JSON:
 *   { url, finalUrl, title, status, detail }
 *
 * status: alive | dead | soft-alive | error
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";

const require = createRequire(
  pathToFileURL(path.join(process.cwd(), "package.json")).href
);

function loadPlaywright() {
  const candidates = [
    path.join(process.cwd(), "pwd", "node_modules", "playwright"),
    path.join(process.cwd(), "node_modules", "playwright"),
    "playwright",
  ];
  for (const c of candidates) {
    try {
      return require(c);
    } catch {
      // try next
    }
  }
  throw new Error("playwright not found (expected under pwd/node_modules)");
}

const DEAD_TITLE_RE =
  /origin dns error|error 1016|error 1000|error 521|web server is down|dns points to prohibited ip|file deleted|page not found|404|doesn't exist|does not exist/i;

async function checkOne(browser, url, timeoutMs) {
  const page = await browser.newPage();
  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    // Allow Cloudflare interstitial / SPA title updates.
    await page.waitForTimeout(2500);
    const title = (await page.title()) || "";
    const finalUrl = page.url();
    const http = response ? response.status() : null;
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) || "");

    const hay = `${title}\n${bodyText}`;
    const looksDead =
      DEAD_TITLE_RE.test(title) ||
      /origin dns error|error 1016|this item was deleted|file deleted|shared_link_disabled|page not found/i.test(
        hay
      );
    if (looksDead) {
      return {
        url,
        finalUrl,
        title,
        http,
        status: "dead",
        detail: `browser dead (title=${JSON.stringify(title)})`,
      };
    }
    if (/checking your browser|just a moment/i.test(title)) {
      return {
        url,
        finalUrl,
        title,
        http,
        status: "soft-alive",
        detail: `browser still challenged (title=${JSON.stringify(title)})`,
      };
    }
    if (http && [404, 410, 451].includes(http)) {
      return {
        url,
        finalUrl,
        title,
        http,
        status: "dead",
        detail: `browser HTTP ${http} (title=${JSON.stringify(title)})`,
      };
    }
    return {
      url,
      finalUrl,
      title,
      http,
      status: "alive",
      detail: `browser ok (title=${JSON.stringify(title)}, HTTP ${http})`,
    };
  } catch (err) {
    return {
      url,
      finalUrl: null,
      title: "",
      http: null,
      status: "error",
      detail: `browser error: ${err.message}`,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

const urls = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const timeoutMs = 20000;
if (!urls.length) {
  console.error("Usage: node scripts/follow-soft-alive.mjs <url> [url...]");
  process.exit(1);
}

const { chromium } = loadPlaywright();
const browser = await chromium.launch({ headless: true });
try {
  const out = [];
  for (const url of urls) {
    out.push(await checkOne(browser, url, timeoutMs));
  }
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
} finally {
  await browser.close();
}
