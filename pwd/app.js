import { deriveMasterKey, passwordFromMaster } from "./derive.js";
import { buildMenu, cleanHostInput, rowForInput } from "./sites.js";

const phraseInput = document.querySelector("#phrase");
const siteInput = document.querySelector("#site");
const siteField = document.querySelector("#site-field");
const form = document.querySelector("#form");
const rememberInput = document.querySelector("#remember");
const menuLabel = document.querySelector("#menu-label");
const menuList = document.querySelector("#menu-list");
const result = document.querySelector("#result");
const passwordEl = document.querySelector("#password");
const copyButton = document.querySelector("#copy");
const toastEl = document.querySelector("#toast");
const errorEl = document.querySelector("#error");

const DB_NAME = "hiz-pwd";
const STORE = "vault";
const RECORD = "device";

let sessionKey = null;
let sessionPhrase = "";
let manualActive = null;
let pinned = null;
let busy = false;
let toastTimer = 0;
let copyDebounceTimer = 0;
let generateSerial = 0;
let passwordText = "";
let lastAutoCopiedPassword = "";
let dismissedExactKey = null;

function rememberEnabled() {
  return document.documentElement.classList.contains("pwa-standalone")
    && rememberInput.checked;
}

phraseInput.addEventListener("input", () => {
  if (phraseInput.value) phraseInput.placeholder = "Long memorable phrase";
  onCredentialsInput();
});

phraseInput.addEventListener("blur", () => {
  void onCredentialsCommit();
});

rememberInput.addEventListener("change", () => {
  void onRememberToggle();
});

siteInput.addEventListener("paste", (event) => {
  const text = event.clipboardData?.getData("text") ?? "";
  const cleaned = cleanHostInput(text);
  if (!cleaned) return;
  event.preventDefault();
  siteInput.value = cleaned;
  resetSelection();
  renderMenu();
  onCredentialsInput();
});

siteInput.addEventListener("input", () => {
  if (looksLikePastedUrl(siteInput.value)) {
    const cleaned = cleanHostInput(siteInput.value);
    if (cleaned && cleaned !== siteInput.value) siteInput.value = cleaned;
  }
  resetSelection();
  renderMenu();
  onCredentialsInput();
});

siteInput.addEventListener("blur", () => {
  void onCredentialsCommit();
});

siteInput.addEventListener("keydown", (event) => {
  const menu = currentMenu();
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (!menu.rows.length) return;
    event.preventDefault();
    pinned = null;
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const start = menu.active < 0 ? (delta > 0 ? -1 : 0) : menu.active;
    manualActive = (start + delta + menu.rows.length) % menu.rows.length;
    renderMenu();
  }
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void onCredentialsCommit();
});

form.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.target instanceof HTMLTextAreaElement) return;
  if (!(event.target instanceof HTMLInputElement)) return;
  event.preventDefault();
  void onCredentialsCommit();
});

function copyPasswordManually() {
  if (passwordText && !passwordEl.classList.contains("pending")) {
    void copyPassword(passwordText);
  }
}

copyButton.addEventListener("click", copyPasswordManually);

passwordEl.addEventListener("click", copyPasswordManually);

renderMenu();
void boot();

function focusPhrase() {
  phraseInput.focus({ preventScroll: true });
}

async function boot() {
  try {
    const saved = await loadMasterKey();
    if (!saved) {
      focusPhrase();
      return;
    }
    wipe(sessionKey);
    sessionKey = saved;
    sessionPhrase = "";
    if (document.documentElement.classList.contains("pwa-standalone")) {
      rememberInput.checked = true;
    }
    phraseInput.placeholder = "Saved on this device";
    focusPhrase();
  } catch {
    await deleteRecord();
    focusPhrase();
  }
}

window.addEventListener("pageshow", () => {
  focusPhrase();
});

async function onRememberToggle() {
  if (!document.documentElement.classList.contains("pwa-standalone")) {
    rememberInput.checked = false;
    return;
  }
  if (rememberInput.checked) {
    if (sessionKey) {
      try {
        await saveMasterKey(sessionKey);
        if (!phraseInput.value) phraseInput.placeholder = "Saved on this device";
      } catch {
        rememberInput.checked = false;
        showError("Could not save the key on this device.");
      }
    }
    return;
  }
  wipe(sessionKey);
  sessionKey = null;
  sessionPhrase = "";
  phraseInput.placeholder = "Long memorable phrase";
  try {
    await deleteRecord();
  } catch {
    showError("Could not forget the saved key.");
  }
  if (!phraseInput.value) phraseInput.focus();
}

function rowForGeneration(commit) {
  if (commit) {
    const menu = currentMenu();
    if (menu.active >= 0) return menu.rows[menu.active];
  }
  return rowForInput(siteInput.value);
}

function readyToGenerate() {
  if (!siteInput.value.trim()) return false;
  if (!phraseInput.value.trim() && !sessionKey) return false;
  return Boolean(rowForInput(siteInput.value));
}

function scheduleCopyAfterIdle() {
  window.clearTimeout(copyDebounceTimer);
  copyDebounceTimer = window.setTimeout(() => {
    if (passwordText) void autoCopyPassword(passwordText);
  }, 1000);
}

function onCredentialsInput() {
  scheduleCopyAfterIdle();
  void generate({ commit: false, copy: false });
}

async function onCredentialsCommit() {
  window.clearTimeout(copyDebounceTimer);
  await generate({ commit: true, copy: true });
}

function clearPasswordOutput() {
  passwordText = "";
  lastAutoCopiedPassword = "";
  result.hidden = true;
  copyButton.hidden = true;
}

async function generate({ commit = false, copy = false } = {}) {
  if (!readyToGenerate()) {
    window.clearTimeout(copyDebounceTimer);
    clearPasswordOutput();
    return;
  }
  const row = rowForGeneration(commit);
  if (!row) {
    clearPasswordOutput();
    return;
  }
  if (commit) {
    commitRow(row);
  }
  clearError();
  const serial = ++generateSerial;
  busy = true;
  form.setAttribute("aria-busy", "true");
  const needsKdf = Boolean(phraseInput.value) && phraseInput.value.normalize("NFC") !== sessionPhrase;
  if (needsKdf) {
    result.hidden = false;
    passwordEl.textContent = "Deriving…";
    passwordEl.classList.add("pending");
    copyButton.hidden = true;
    passwordText = "";
  }
  try {
    const master = await masterKey();
    if (serial !== generateSerial) return;
    const password = await passwordFromMaster(master, row.key);
    if (serial !== generateSerial) return;
    passwordText = password;
    result.hidden = false;
    passwordEl.textContent = password;
    passwordEl.classList.remove("pending");
    copyButton.hidden = false;
    if (copy) await autoCopyPassword(password);
  } catch (error) {
    if (serial !== generateSerial) return;
    clearPasswordOutput();
    showError(error instanceof Error ? error.message : "Could not generate a password.");
  } finally {
    if (serial === generateSerial) {
      busy = false;
      form.removeAttribute("aria-busy");
    }
  }
}

async function masterKey() {
  const phrase = phraseInput.value.normalize("NFC");
  if (phrase) {
    if (sessionKey && sessionPhrase === phrase) return sessionKey;
    const derived = await deriveMasterKey(phrase);
    wipe(sessionKey);
    sessionKey = derived;
    sessionPhrase = phrase;
    if (rememberEnabled()) {
      await saveMasterKey(sessionKey);
      phraseInput.value = "";
      sessionPhrase = "";
      phraseInput.placeholder = "Saved on this device";
    }
    return sessionKey;
  }
  if (sessionKey) return sessionKey;
  throw new Error("Enter a passphrase first.");
}

async function autoCopyPassword(text) {
  if (text === lastAutoCopiedPassword) return;
  lastAutoCopiedPassword = text;
  await copyToClipboardWithToast(text);
}

async function copyPassword(text) {
  lastAutoCopiedPassword = text;
  await copyToClipboardWithToast(text);
}

async function copyToClipboardWithToast(text) {
  const ok = await writeClipboard(text);
  toast(ok ? "Copied to clipboard" : "Could not copy");
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function looksLikePastedUrl(value) {
  const text = value.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
    || /^www\./i.test(text)
    || /[/?#]/.test(text);
}

function resetSelection() {
  manualActive = null;
  pinned = null;
  dismissedExactKey = null;
}

function pinRow(row) {
  manualActive = null;
  pinned = { kind: row.kind, key: row.key };
}

function dismissExactRowIfNeeded(row) {
  if (row?.kind === "exact") dismissedExactKey = row.key;
}

function commitRow(row) {
  dismissExactRowIfNeeded(row);
  pinRow(row);
  if (siteInput.value !== row.name) siteInput.value = row.name;
  renderMenu();
}

function applyDismissedExact(menu) {
  if (!dismissedExactKey) return menu;
  const rows = menu.rows.filter(
    (row) => !(row.kind === "exact" && row.key === dismissedExactKey),
  );
  if (rows.length === menu.rows.length) return menu;
  let active = menu.active;
  if (active >= 0) {
    const selected = menu.rows[active];
    const next = rows.findIndex(
      (row) => row.kind === selected.kind && row.key === selected.key,
    );
    active = next;
  }
  if (active < 0 && rows.length === 1) active = 0;
  return { ...menu, rows, active };
}

function currentMenu() {
  const menu = applyDismissedExact(buildMenu(siteInput.value));
  if (manualActive != null && menu.rows.length) {
    const active = Math.max(0, Math.min(menu.rows.length - 1, manualActive));
    return { ...menu, active };
  }
  if (pinned && menu.rows.length) {
    const index = menu.rows.findIndex((row) => row.kind === pinned.kind && row.key === pinned.key);
    if (index >= 0) return { ...menu, active: index };
    pinned = null;
  }
  return menu;
}

function renderMenu() {
  const menu = currentMenu();
  const hasSuggestions = menu.rows.length > 0;
  siteField.classList.toggle("has-suggestions", hasSuggestions);
  menuLabel.hidden = !menu.label;
  menuLabel.textContent = menu.label || "";
  menuList.replaceChildren();
  siteInput.setAttribute("aria-expanded", hasSuggestions ? "true" : "false");
  const activeId = menu.active >= 0 ? `opt-${menu.active}` : "";
  if (activeId) siteInput.setAttribute("aria-activedescendant", activeId);
  else siteInput.removeAttribute("aria-activedescendant");

  menu.rows.forEach((row, index) => {
    const item = document.createElement("li");
    item.setAttribute("role", "presentation");
    const button = document.createElement("button");
    button.type = "button";
    button.id = `opt-${index}`;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", index === menu.active ? "true" : "false");
    button.className = row.kind === "exact" ? "exact" : "";
    button.textContent = row.kind === "exact" ? `Use “${row.name}”` : row.name;
    const choose = (event) => {
      if (event) event.preventDefault();
      commitRow(row);
      siteInput.focus();
      onCredentialsInput();
    };
    button.addEventListener("pointerdown", (event) => {
      if (event.button > 0) return;
      choose(event);
    });
    button.addEventListener("click", choose);
    item.appendChild(button);
    menuList.appendChild(item);
  });
  if (menu.active >= 0) {
    menuList.querySelector(`#opt-${menu.active}`)?.scrollIntoView({ block: "nearest" });
  }
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.classList.remove("show");
  }, 1700);
}

function showError(message) {
  errorEl.hidden = false;
  errorEl.textContent = message;
}

function clearError() {
  errorEl.hidden = true;
  errorEl.textContent = "";
}

function wipe(bytes) {
  if (bytes) bytes.fill(0);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function withStore(mode, run) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    let settled = false;
    let result;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      db.close();
      if (error) reject(error);
      else resolve(result);
    };
    const tx = db.transaction(STORE, mode);
    const request = run(tx.objectStore(STORE));
    request.onsuccess = () => {
      result = request.result;
    };
    request.onerror = () => finish(request.error || new Error("Storage request failed"));
    tx.oncomplete = () => finish();
    tx.onerror = () => finish(tx.error || new Error("Storage request failed"));
    tx.onabort = () => finish(tx.error || new Error("Storage request failed"));
  }));
}

async function saveMasterKey(bytes) {
  const wrappingKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrappingKey, bytes);
  await withStore("readwrite", (store) => store.put({ wrappingKey, iv, ct }, RECORD));
}

async function loadMasterKey() {
  const record = await withStore("readonly", (store) => store.get(RECORD));
  if (!record?.wrappingKey || !record.iv || !record.ct) return null;
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: record.iv },
    record.wrappingKey,
    record.ct,
  );
  return new Uint8Array(plain);
}

function deleteRecord() {
  return withStore("readwrite", (store) => store.delete(RECORD));
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
