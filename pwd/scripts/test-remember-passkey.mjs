/**
 * Remember + WebAuthn PRF, driven in Chromium with a virtual platform
 * authenticator (a stand-in for Face ID). Emulates an iPhone home-screen app.
 *
 *   node scripts/test-remember-passkey.mjs
 */
import { chromium, devices } from "playwright";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PHRASE = "remember-test-passphrase";

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

// Served under /pwd/ like production, so the service worker is active too.
const server = createServer((req, res) => {
  let path = req.url.split("?")[0];
  if (!path.startsWith("/pwd/")) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  path = path.slice("/pwd/".length) || "index.html";
  const file = join(root, path);
  try {
    const body = readFileSync(file);
    res.writeHead(200, { "Content-Type": contentType(file) });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, resolve));
// WebAuthn needs a secure context and a domain RP ID; localhost is both.
const APP_URL = `http://localhost:${server.address().port}/pwd/`;

const browser = await chromium.launch({ headless: true });
let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`  ok   ${message}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${message}`);
}

async function openApp({ hasPrf = true, stripCreatePrf = false } = {}) {
  const context = await browser.newContext({ ...devices["iPhone 13"] });
  await context.addInitScript(({ stripCreatePrf }) => {
    // iOS home-screen app.
    Object.defineProperty(Navigator.prototype, "standalone", { configurable: true, get: () => true });
    const calls = { create: 0, get: 0 };
    window.__webauthn = calls;
    const create = navigator.credentials.create.bind(navigator.credentials);
    const get = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.create = async (options) => {
      calls.create += 1;
      const credential = await create(options);
      if (stripCreatePrf && credential) {
        // Platforms that only say prf.enabled at registration, without a secret.
        const results = credential.getClientExtensionResults.bind(credential);
        credential.getClientExtensionResults = () => {
          const out = results();
          if (out.prf) out.prf = { enabled: true };
          return out;
        };
      }
      return credential;
    };
    navigator.credentials.get = async (options) => {
      calls.get += 1;
      if (sessionStorage.getItem("cancelNextGet")) {
        // What Safari reports when the user dismisses Face ID.
        sessionStorage.removeItem("cancelNextGet");
        throw new DOMException("The operation was not allowed.", "NotAllowedError");
      }
      return get(options);
    };
  }, { stripCreatePrf });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf,
      automaticPresenceSimulation: true,
    },
  });
  const app = {
    context,
    page,
    async load() {
      await page.goto(APP_URL, { waitUntil: "load" });
      await page.waitForFunction(() => Boolean(globalThis.hashwasm?.argon2id), null, { timeout: 30000 });
      // boot() reads IndexedDB; the remember switch reflects it once boot is done.
      await page.waitForTimeout(400);
    },
    async reload() {
      await page.reload({ waitUntil: "load" });
      await page.waitForFunction(() => Boolean(globalThis.hashwasm?.argon2id), null, { timeout: 30000 });
      await page.waitForTimeout(400);
    },
    calls: () => page.evaluate(() => ({ ...window.__webauthn })),
    // Survives a reload, so it can cancel the launch prompt.
    cancelNextPrompt: () => page.evaluate(() => sessionStorage.setItem("cancelNextGet", "1")),
    async settle() {
      await page.waitForFunction(() => document.querySelector("#password").textContent !== "Unlocking…", null, { timeout: 30000 });
      await page.waitForTimeout(200);
    },
    async credentialCount() {
      const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
      return credentials.length;
    },
    async setPhrase(value) {
      await page.evaluate((text) => {
        const phrase = document.querySelector("#phrase");
        phrase.removeAttribute("readonly");
        phrase.value = text;
        phrase.dispatchEvent(new Event("input", { bubbles: true }));
      }, value);
    },
    async typeSite(value) {
      await page.evaluate(() => {
        const site = document.querySelector("#site");
        site.value = "";
        site.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.click("#site");
      await page.keyboard.type(value, { delay: 30 });
    },
    async password() {
      await page.waitForFunction(
        () => {
          const el = document.querySelector("#password");
          return !document.querySelector("#result").hidden
            && el.textContent.length === 17
            && !el.classList.contains("pending");
        },
        null,
        { timeout: 60000 },
      );
      return page.locator("#password").textContent();
    },
    error: () => page.evaluate(() => {
      const el = document.querySelector("#error");
      return el.hidden ? "" : el.textContent;
    }),
    state: () => page.evaluate(() => ({
      remember: document.querySelector("#remember").checked,
      phraseValue: document.querySelector("#phrase").value,
      placeholder: document.querySelector("#phrase").placeholder,
      locked: document.documentElement.classList.contains("passphrase-locked"),
      sealed: document.documentElement.classList.contains("passphrase-sealed"),
      resultHidden: document.querySelector("#result").hidden,
      passwordText: document.querySelector("#password").textContent,
      resultLocked: document.querySelector("#password").classList.contains("locked"),
    })),
    record: () => page.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open("hiz-pwd", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("vault");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const request = db.transaction("vault", "readonly").objectStore("vault").get("device");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const value = request.result;
          db.close();
          if (!value) {
            resolve(null);
            return;
          }
          resolve({
            keys: Object.keys(value).sort().join(","),
            v: value.v ?? null,
            format: value.format ?? null,
            hasCryptoKey: Object.values(value).some((item) => item instanceof CryptoKey),
            ctLength: value.ct?.byteLength ?? 0,
            credentialIdLength: value.credentialId?.byteLength ?? 0,
          });
        };
      };
    })),
    async background(ms) {
      await page.evaluate((awayMs) => {
        const setVisibility = (state) => {
          Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
          document.dispatchEvent(new Event("visibilitychange"));
        };
        setVisibility("hidden");
        const realNow = Date.now.bind(Date);
        Date.now = () => realNow() + awayMs;
        setVisibility("visible");
        Date.now = realNow;
      }, ms);
    },
    close: () => context.close(),
  };
  return app;
}

console.log("A. Remember off: no passkey prompts at all");
const a = await openApp();
await a.load();
check((await a.state()).remember === false, "remember starts off");
await a.setPhrase(PHRASE);
await a.typeSite("amazon");
const expected = await a.password();
check(expected.length === 17, `password generated without remember (${expected.length} chars)`);
let calls = await a.calls();
check(calls.create === 0 && calls.get === 0, `no WebAuthn calls (create=${calls.create}, get=${calls.get})`);
await a.reload();
calls = await a.calls();
check(calls.create === 0 && calls.get === 0, "relaunch without remember makes no WebAuthn calls");

console.log("B. Turn Remember on after typing the passphrase");
await a.setPhrase(PHRASE);
await a.typeSite("amazon");
check((await a.password()) === expected, "same password before enabling remember");
await a.page.click("#remember");
await a.page.waitForFunction(() => document.querySelector("#phrase").placeholder === "Saved on this device", null, { timeout: 10000 });
calls = await a.calls();
check(calls.create === 1, `one passkey created (create=${calls.create}, get=${calls.get})`);
check(await a.credentialCount() === 1, "authenticator holds one passkey");
let record = await a.record();
check(record?.v === 2 && record.format === 2 && record.ctLength === 48, `v2 record with sealed key (${JSON.stringify(record)})`);
check(record && !record.hasCryptoKey, "no AES key stored next to the ciphertext");
let state = await a.state();
check(state.remember && state.phraseValue === "", "remember on and passphrase field cleared");
check(state.locked && !state.sealed, "field shows saved-and-unlocked state");

console.log("C. Relaunch with Remember: one Face ID prompt at launch, none while typing");
await a.reload();
await a.settle();
calls = await a.calls();
check(calls.get === 1 && calls.create === 0, `one prompt at launch (get=${calls.get})`);
state = await a.state();
check(state.placeholder === "Saved on this device" && !state.sealed, `unlocked at launch ("${state.placeholder}")`);
check(state.resultHidden, "password area stays empty until a site is typed");
await a.typeSite("amazon");
check((await a.password()) === expected, "unlocked key yields the same password");
await a.typeSite("chase");
await a.password();
calls = await a.calls();
check(calls.get === 1, `typing sites never prompts (get=${calls.get})`);

console.log("D. Re-lock after a minute away: password area says Tap to unlock");
await a.typeSite("amazon");
await a.password();
await a.background(20 * 1000);
state = await a.state();
check(!state.resultHidden && !state.resultLocked, "20 seconds away keeps the key unlocked");
await a.background(61 * 1000);
state = await a.state();
check(!state.resultHidden && state.resultLocked && state.passwordText === "Tap to unlock",
  `61 seconds away re-locks ("${state.passwordText}")`);
check(state.sealed && state.placeholder === "Saved · tap to unlock", "passphrase field shows locked too");
await a.typeSite("chase");
await a.page.waitForTimeout(400);
state = await a.state();
calls = await a.calls();
check(calls.get === 1 && state.passwordText === "Tap to unlock", `typing while locked does not prompt (get=${calls.get})`);
await a.page.click("#password");
await a.typeSite("amazon");
check((await a.password()) === expected, "tapping the password area unlocks and generates");
calls = await a.calls();
check(calls.get === 2, `exactly one prompt for the tap (get=${calls.get})`);

console.log("E. Launch prompt cancelled: Tap to unlock, no error, no prompts while typing");
await a.cancelNextPrompt();
await a.reload();
await a.settle();
state = await a.state();
calls = await a.calls();
check(calls.get === 1, `launch prompt was shown once (get=${calls.get})`);
check(!state.resultHidden && state.resultLocked && state.passwordText === "Tap to unlock", `password area says "${state.passwordText}"`);
check((await a.error()) === "", "cancel shows no error");
await a.typeSite("amazon");
await a.page.waitForTimeout(400);
calls = await a.calls();
check(calls.get === 1 && (await a.state()).passwordText === "Tap to unlock", "typing after cancel does not prompt");
check((await a.record())?.ctLength === 48, "cancel keeps the saved key");
await a.page.click("#phrase-field");
check((await a.password()) === expected, "tapping the passphrase field unlocks and generates");
calls = await a.calls();
check(calls.get === 2, `one prompt for the tap (get=${calls.get})`);

console.log("F. Turn Remember off: no prompt, record removed");
const before = await a.calls();
await a.page.click("#remember");
await a.page.waitForTimeout(300);
calls = await a.calls();
check(calls.get === before.get && calls.create === before.create, "forgetting does not prompt");
check(await a.record() === null, "record deleted");
const leftAfterForget = await a.credentialCount();
check(leftAfterForget <= 1, `no extra passkeys after forgetting (${leftAfterForget} left, 0 if the browser honors signalUnknownCredential)`);
await a.reload();
state = await a.state();
calls = await a.calls();
check(!state.remember && state.placeholder === "Long memorable phrase", "relaunch shows a fresh passphrase field");
check(calls.get === 0, "no prompt after forgetting");

console.log("G. Re-enable Remember leaves a single passkey");
await a.page.click("#remember");
await a.page.waitForFunction(() => document.querySelector("#remember").checked, null, { timeout: 10000 });
await a.page.waitForTimeout(300);
check(await a.credentialCount() === 1, `still one passkey on the authenticator (${await a.credentialCount()})`);
await a.close();

console.log("H. Platform without PRF results at registration (extra get), save after relaunch");
const h = await openApp({ stripCreatePrf: true });
await h.load();
await h.page.click("#remember");
await h.page.waitForFunction(() => document.querySelector("#remember").checked, null, { timeout: 10000 });
await h.page.waitForTimeout(300);
calls = await h.calls();
check(calls.create === 1 && calls.get === 1, `create then one get for the secret (create=${calls.create}, get=${calls.get})`);
record = await h.record();
check(record?.v === 2 && record.ctLength === 0, "enrolled record waits for a key");
await h.setPhrase(PHRASE);
await h.typeSite("amazon");
check((await h.password()) === expected, "password matches");
calls = await h.calls();
check(calls.get === 1, "saving right after enrolling reuses the unlocked wrap key");
check((await h.record())?.ctLength === 48, "key saved");
await h.page.click("#remember");
await h.page.waitForTimeout(200);
await h.page.click("#remember");
await h.page.waitForFunction(() => document.querySelector("#remember").checked, null, { timeout: 10000 });
await h.page.waitForTimeout(300);
await h.reload();
check((await h.state()).remember && (await h.record())?.ctLength === 0, "relaunch with enrolled but empty record");
await h.setPhrase(PHRASE);
await h.typeSite("amazon");
check((await h.password()) === expected, "password matches");
await h.page.waitForFunction(() => document.querySelector("#phrase").value === "", null, { timeout: 10000 });
calls = await h.calls();
check(calls.get === 1 && (await h.record())?.ctLength === 48, `saving after relaunch prompts once (get=${calls.get})`);
await h.reload();
await h.typeSite("amazon");
check((await h.password()) === expected, "unlock after relaunch matches");
await h.close();

console.log("I. Authenticator without PRF: Remember refuses and stays off");
const i = await openApp({ hasPrf: false });
await i.load();
await i.page.click("#remember");
await i.page.waitForFunction(() => !document.querySelector("#error").hidden, null, { timeout: 10000 });
state = await i.state();
check(!state.remember, "remember switched back off");
check((await i.error()).includes("can't lock"), `explains why ("${await i.error()}")`);
check(await i.record() === null, "nothing stored");
await i.close();

console.log("J. Old ungated record is dropped on upgrade");
const j = await openApp();
await j.load();
await j.page.evaluate(() => new Promise((resolve, reject) => {
  const open = indexedDB.open("hiz-pwd", 1);
  open.onupgradeneeded = () => open.result.createObjectStore("vault");
  open.onerror = () => reject(open.error);
  open.onsuccess = async () => {
    const wrappingKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrappingKey, new Uint8Array(32));
    const db = open.result;
    const tx = db.transaction("vault", "readwrite");
    tx.objectStore("vault").put({ wrappingKey, iv, ct }, "device");
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  };
}));
await j.reload();
state = await j.state();
calls = await j.calls();
check(await j.record() === null, "legacy record deleted");
check(!state.remember && calls.get === 0, "remember off, no prompt");
check((await j.error()).includes("Turn it on again"), `notice shown ("${await j.error()}")`);
await j.close();

console.log("K. Key saved under the old password format: passkey kept, key re-saved");
const k = await openApp();
await k.load();
await k.setPhrase(PHRASE);
await k.typeSite("amazon");
await k.password();
await k.page.click("#remember");
await k.page.waitForFunction(() => document.querySelector("#phrase").placeholder === "Saved on this device", null, { timeout: 10000 });
await k.page.evaluate(() => new Promise((resolve, reject) => {
  const open = indexedDB.open("hiz-pwd", 1);
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const db = open.result;
    const store = db.transaction("vault", "readwrite").objectStore("vault");
    const get = store.get("device");
    get.onsuccess = () => {
      const record = get.result;
      delete record.format;
      store.put(record, "device").onsuccess = () => {
        db.close();
        resolve();
      };
    };
  };
}));
await k.reload();
state = await k.state();
calls = await k.calls();
record = await k.record();
check(state.remember && record?.ctLength === 0 && record.credentialIdLength !== 0, "stale key dropped, passkey enrollment kept");
check(calls.get === 0 && calls.create === 0, "no prompt at launch");
check((await k.error()).includes("new format"), `notice shown ("${await k.error()}")`);
await k.setPhrase(PHRASE);
await k.typeSite("amazon");
check((await k.password()) === expected, "password from the typed passphrase");
await k.page.waitForFunction(() => document.querySelector("#phrase").value === "", null, { timeout: 10000 });
calls = await k.calls();
record = await k.record();
check(calls.create === 0 && calls.get === 1, `re-saving reuses the passkey with one prompt (create=${calls.create}, get=${calls.get})`);
check(record?.format === 2 && record.ctLength === 48, "key saved in the new format");
await k.close();

await browser.close();
server.close();
if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nremember passkey ok");
