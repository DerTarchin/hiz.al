import { chromium, devices } from "playwright";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

const server = createServer((req, res) => {
  const path = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const file = join(root, path.replace(/^\//, ""));
  try {
    const body = readFileSync(file);
    res.writeHead(200, { "Content-Type": contentType(file) });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  ...devices["iPhone 13"],
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage();

await page.addInitScript(() => {
  let gestureActive = false;
  const armGesture = () => {
    gestureActive = true;
  };
  document.addEventListener("pointerdown", armGesture, true);
  document.addEventListener("touchstart", armGesture, true);
  const originalWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
  navigator.clipboard.writeText = async (text) => {
    if (!gestureActive) throw new DOMException("clipboard blocked", "NotAllowedError");
    gestureActive = false;
    return originalWrite(text);
  };
  const originalExec = Document.prototype.execCommand;
  Document.prototype.execCommand = function (command, ...args) {
    if (command === "copy" && !gestureActive) return false;
    gestureActive = false;
    return originalExec.call(this, command, ...args);
  };
});

await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle" });
await page.waitForFunction(() => Boolean(globalThis.hashwasm?.argon2id), { timeout: 30000 });

await page.evaluate(() => {
  const phrase = document.querySelector("#phrase");
  const site = document.querySelector("#site");
  phrase.removeAttribute("readonly");
  phrase.value = "autocopy-test-passphrase";
  phrase.dispatchEvent(new Event("input", { bubbles: true }));
  site.value = "amazon";
  site.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForFunction(
  () => document.querySelector("#password")?.textContent?.length === 17
    && !document.querySelector("#password")?.classList.contains("pending"),
  { timeout: 120000 },
);

await page.waitForTimeout(600);

let clipboard = "";
try {
  clipboard = await page.evaluate(() => navigator.clipboard.readText());
} catch {
  clipboard = "";
}
if (clipboard.length === 17) {
  throw new Error("auto-copy should not succeed without a user gesture on iOS");
}

await page.locator("#site").dispatchEvent("pointerdown");
await page.waitForTimeout(50);

clipboard = await page.evaluate(() => navigator.clipboard.readText());
if (clipboard.length !== 17) {
  throw new Error(`expected password copied after pointerdown, got length ${clipboard.length}`);
}

await page.evaluate(() => {
  document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
});
await page.fill("#site", "amazon ");
await page.waitForTimeout(600);
await page.locator("#password").dispatchEvent("pointerdown");
clipboard = await page.evaluate(() => navigator.clipboard.readText());
if (clipboard.length !== 17) {
  throw new Error("pending auto-copy should flush on the next gesture");
}

console.log("autocopy ok", { length: clipboard.length });

await browser.close();
server.close();
