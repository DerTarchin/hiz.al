import {
  DEFAULT_SITE_VERSION,
  FORMAT_VERSION,
  deriveMasterKey,
  normalizeSiteVersion,
  passwordFromMaster,
} from "./derive.js";
import { buildMenu, cleanHostInput, loadSiteCatalog, matchHighlightRange, rowForInput } from "./sites.js";

const phraseInput = document.querySelector("#phrase");
const phraseField = document.querySelector("#phrase-field");
const siteInput = document.querySelector("#site");
const siteClearBtn = document.querySelector("#site-clear");
const siteField = document.querySelector("#site-field");
const versionPicker = document.querySelector("#version-picker");
const versionBtn = document.querySelector("#version");
const versionMenu = document.querySelector("#version-menu");
const form = document.querySelector("#form");
const rememberInput = document.querySelector("#remember");
const menuLabel = document.querySelector("#menu-label");
const menuList = document.querySelector("#menu-list");
const result = document.querySelector("#result");
const passwordEl = document.querySelector("#password");
const copyButton = document.querySelector("#copy");
const copyDoneEl = copyButton.querySelector(".copy-btn__done");
const errorEl = document.querySelector("#error");

const DB_NAME = "hiz-pwd";
const STORE = "vault";
const RECORD = "device";
const PASSKEY_USER = "passkey-user";
const SITE_VERSIONS_KEY = "hizPwdSiteVersions";
const PHRASE_IDLE_MS = 250;

/**
 * Remember keeps the Argon2id master key wrapped with AES-GCM. The wrapping
 * key comes from the WebAuthn PRF extension of a platform passkey, so reading
 * the saved key back needs Face ID / Touch ID. Stored record:
 *   { v: 2, credentialId, prfSalt, iv, ct }   (iv/ct are absent until a key is saved)
 * Records from before v2 held the AES key next to the ciphertext and are dropped.
 */
const RECORD_VERSION = 2;
const WRAP_INFO = new TextEncoder().encode("hiz.al/pwd remember v2");
const RELOCK_AFTER_MS = 60 * 1000;
const PLACEHOLDER_DEFAULT = "Long memorable phrase";
const PLACEHOLDER_SAVED = "Saved on this device";
const PLACEHOLDER_LOCKED = "Saved · tap to unlock";
const LOCKED_TEXT = "Tap to unlock";
const UNLOCKING_TEXT = "Unlocking…";
const PRF_UNSUPPORTED = "This device can't lock a remembered passphrase behind Face ID.";

let sessionKey = null;
let sessionPhrase = "";
let sessionFromSaved = false;
let savedRecord = null;
let passkeyUserId = null;
let prfWrap = null;
let unlockPromise = null;
let rememberPromise = null;
let hiddenAt = 0;
let manualActive = null;
let pinned = null;
let busy = false;
let copiedFeedbackTimer = 0;
let copyDebounceTimer = 0;
let phraseDeriveTimer = 0;
let pendingDerive = null;
let copyWhenReady = false;
let generateSerial = 0;
let passwordText = "";
let lastAutoCopiedPassword = "";
let pendingAutoCopyText = "";
const COPY_IDLE_MS = 500;
let dismissedExactKey = null;
let suppressSiteBlurCommit = false;

function rememberEnabled() {
  return document.documentElement.classList.contains("pwa-standalone")
    && rememberInput.checked;
}

function isIosDevice() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function shouldLockPassphrase() {
  return isIosDevice()
    && document.documentElement.classList.contains("pwa-standalone")
    && rememberInput.checked
    && (Boolean(sessionKey) || hasSavedKey())
    && !phraseInput.value.trim();
}

function hasSavedKey() {
  return Boolean(savedRecord?.ct) && savedRecord.format === FORMAT_VERSION;
}

/** A key is saved on this device but has not been unlocked with Face ID yet. */
function savedKeyLocked() {
  return hasSavedKey() && !(sessionKey && sessionFromSaved);
}

/** The only key available is the saved one, and it is still locked. */
function keyIsLocked() {
  return !phraseInput.value && !sessionKey && hasSavedKey();
}

function syncPassphrasePlaceholder() {
  if (!hasSavedKey()) phraseInput.placeholder = PLACEHOLDER_DEFAULT;
  else phraseInput.placeholder = savedKeyLocked() ? PLACEHOLDER_LOCKED : PLACEHOLDER_SAVED;
}

function updatePassphraseFieldState() {
  syncPassphrasePlaceholder();
  syncLockedResult();
  const lock = shouldLockPassphrase();
  document.documentElement.classList.toggle("passphrase-locked", lock);
  document.documentElement.classList.toggle(
    "passphrase-sealed",
    savedKeyLocked() && !phraseInput.value,
  );
  phraseInput.tabIndex = lock ? -1 : 0;
  if (lock) {
    phraseInput.setAttribute("readonly", "");
    phraseInput.setAttribute("aria-disabled", "true");
    return;
  }
  phraseInput.removeAttribute("aria-disabled");
  if (!phraseInput.value) phraseInput.setAttribute("readonly", "");
}

/** Shows or clears "Tap to unlock" in the password area. */
function syncLockedResult() {
  if (keyIsLocked() || passwordEl.classList.contains("locked")) clearPasswordOutput();
}

function focusSite() {
  siteInput.focus({ preventScroll: true });
}

function focusInitial() {
  if (shouldLockPassphrase()) focusSite();
  else focusPhrase();
}

phraseInput.addEventListener("focus", () => {
  if (!shouldLockPassphrase()) return;
  phraseInput.blur();
  focusSite();
});

phraseInput.addEventListener("mousedown", () => {
  if (shouldLockPassphrase()) return;
  phraseInput.removeAttribute("readonly");
});

phraseInput.addEventListener("keydown", () => {
  if (shouldLockPassphrase()) return;
  phraseInput.removeAttribute("readonly");
});

phraseField.addEventListener("click", () => {
  if (!keyIsLocked() || unlockPromise) return;
  void unlockAndGenerate({ copy: true });
});

phraseInput.addEventListener("input", () => {
  syncPassphrasePlaceholder();
  clearCopiedFeedback();
  flushPendingAutoCopy();
  // Argon2id at 64 MiB takes a noticeable moment; derive once typing pauses.
  window.clearTimeout(phraseDeriveTimer);
  phraseDeriveTimer = window.setTimeout(() => {
    scheduleCopyAfterIdle();
    void generate({ commit: false, copy: false });
  }, PHRASE_IDLE_MS);
});

phraseInput.addEventListener("blur", () => {
  window.clearTimeout(phraseDeriveTimer);
  void onCredentialsCommit(null, { implicit: true });
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

menuList.addEventListener("mousedown", (event) => {
  event.preventDefault();
});

siteClearBtn.addEventListener("mousedown", (event) => {
  event.preventDefault();
});

siteClearBtn.addEventListener("click", () => {
  siteInput.value = "";
  resetSelection();
  window.clearTimeout(copyDebounceTimer);
  clearPasswordOutput();
  renderMenu();
  siteInput.focus();
});

function syncSiteClear() {
  siteClearBtn.hidden = siteInput.value.length === 0;
}

siteInput.addEventListener("blur", (event) => {
  if (suppressSiteBlurCommit) return;
  const next = event.relatedTarget;
  if (next instanceof Node && menuList.contains(next)) return;
  if (next === siteClearBtn) return;
  void onCredentialsCommit(null, { implicit: true });
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

function onPasswordTap() {
  if (passwordEl.classList.contains("locked")) {
    if (keyIsLocked() && !unlockPromise) void unlockAndGenerate({ copy: true });
    return;
  }
  copyPasswordManually();
}

copyButton.addEventListener("click", copyPasswordManually);

passwordEl.addEventListener("click", onPasswordTap);

passwordEl.addEventListener("keydown", (event) => {
  if (!passwordEl.classList.contains("locked")) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  onPasswordTap();
});

installDeferredAutoCopyFlush();

renderMenu();
void boot();

function focusPhrase() {
  phraseInput.focus({ preventScroll: true });
}

async function boot() {
  try {
    await loadSiteCatalog();
  } catch {
    /* embedded catalog stays in place */
  }
  const standalone = document.documentElement.classList.contains("pwa-standalone");
  try {
    const userId = await readStored(PASSKEY_USER);
    if (userId instanceof Uint8Array) passkeyUserId = userId;
  } catch {
    /* Remember makes a new passkey user handle when it is turned on */
  }
  let saved = null;
  try {
    saved = await readStored(RECORD);
  } catch {
    saved = null;
  }
  if (saved && !isCurrentRecord(saved)) {
    saved = null;
    try {
      await deleteStored(RECORD);
    } catch {
      /* the next save overwrites it */
    }
    if (standalone) {
      showError("Remember now unlocks with Face ID. Turn it on again to save your passphrase.");
    }
  }
  if (saved?.ct && saved.format !== FORMAT_VERSION) {
    // Saved under an older password format: keep the passkey, drop the key.
    saved = { v: saved.v, credentialId: saved.credentialId, prfSalt: saved.prfSalt };
    try {
      await writeStored(RECORD, saved);
    } catch {
      /* hasSavedKey() ignores the stale key either way */
    }
    if (standalone) {
      showError("Passwords use a new format. Type your passphrase once to save it again.");
    }
  }
  savedRecord = saved;
  if (savedRecord && standalone) rememberInput.checked = true;
  updatePassphraseFieldState();
  focusInitial();
  // A saved passphrase asks for Face ID once at launch. Typing never does.
  if (keyIsLocked()) void unlockAndGenerate({ copy: false });
}

window.addEventListener("pageshow", () => {
  relockIfAway();
  updatePassphraseFieldState();
  focusInitial();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    hiddenAt = Date.now();
    return;
  }
  relockIfAway();
});

/** After a minute in the background, the unlocked saved key needs Face ID again. */
function relockIfAway() {
  const away = hiddenAt ? Date.now() - hiddenAt : 0;
  hiddenAt = 0;
  if (away < RELOCK_AFTER_MS || !sessionFromSaved) return;
  wipe(sessionKey);
  sessionKey = null;
  sessionPhrase = "";
  sessionFromSaved = false;
  prfWrap = null;
  window.clearTimeout(copyDebounceTimer);
  clearPasswordOutput();
  clearError();
  updatePassphraseFieldState();
}

async function onRememberToggle() {
  if (!document.documentElement.classList.contains("pwa-standalone")) {
    rememberInput.checked = false;
    return;
  }
  clearError();
  if (rememberInput.checked) {
    rememberPromise = enableRemember();
    try {
      await rememberPromise;
    } catch (error) {
      rememberInput.checked = false;
      showError(error?.cancelled
        ? "Remember stays off because Face ID was cancelled."
        : errorText(error, "Could not turn on Remember."));
    } finally {
      rememberPromise = null;
      updatePassphraseFieldState();
    }
    return;
  }
  try {
    await forgetSavedKey();
  } catch {
    showError("Could not forget the saved key.");
  }
  updatePassphraseFieldState();
  if (!phraseInput.value) focusInitial();
}

/**
 * Asks for Face ID, then shows the password for the current site. Starts the
 * WebAuthn call before any await, so a tap that led here counts as the gesture.
 */
async function unlockAndGenerate({ copy }) {
  const pending = unlockSavedKey();
  clearError();
  clearPasswordOutput();
  try {
    await pending;
  } catch (error) {
    if (!error?.cancelled) showError(errorText(error, "Could not unlock the saved passphrase."));
    clearPasswordOutput();
    return;
  }
  if (readyToGenerate()) await generate({ commit: false, copy });
  else clearPasswordOutput();
}

function rowForPinnedCommit() {
  if (!pinned) return null;
  const menu = currentMenu();
  const fromMenu = menu.rows.find(
    (row) => row.kind === pinned.kind && row.key === pinned.key,
  );
  if (fromMenu) return fromMenu;
  const fromInput = rowForInput(siteInput.value);
  if (fromInput && fromInput.kind === pinned.kind && fromInput.key === pinned.key) {
    return fromInput;
  }
  return null;
}

function rowForExplicitCommit() {
  const pinnedRow = rowForPinnedCommit();
  if (pinnedRow) return pinnedRow;
  const menu = currentMenu();
  if (manualActive != null && menu.rows.length) {
    const index = Math.max(0, Math.min(menu.rows.length - 1, manualActive));
    return menu.rows[index];
  }
  if (menu.active >= 0) return menu.rows[menu.active];
  return rowForInput(siteInput.value);
}

function rowForImplicitCommit() {
  const pinnedRow = rowForPinnedCommit();
  if (pinnedRow) return pinnedRow;
  const row = rowForInput(siteInput.value);
  if (row?.kind === "site") return row;
  return null;
}

function rowForGeneration(commit) {
  if (commit) return rowForExplicitCommit();
  return rowForInput(siteInput.value);
}

function readyToGenerate() {
  if (!siteInput.value.trim()) return false;
  if (!phraseInput.value.trim() && !sessionKey && !hasSavedKey()) return false;
  return Boolean(rowForInput(siteInput.value));
}

function scheduleCopyAfterIdle() {
  window.clearTimeout(copyDebounceTimer);
  copyDebounceTimer = window.setTimeout(() => {
    if (passwordEl.classList.contains("pending")) {
      copyWhenReady = true;
      return;
    }
    if (!passwordText) return;
    void performAutoCopy(passwordText);
  }, COPY_IDLE_MS);
}

function flushPendingAutoCopy() {
  if (!pendingAutoCopyText || pendingAutoCopyText === lastAutoCopiedPassword) return;
  if (!passwordText || passwordEl.classList.contains("pending")) return;
  void performAutoCopy(pendingAutoCopyText);
}

function installDeferredAutoCopyFlush() {
  const flush = () => flushPendingAutoCopy();
  for (const eventName of ["pointerdown", "touchstart"]) {
    form.addEventListener(eventName, flush, { capture: true, passive: true });
  }
}

function onCredentialsInput() {
  clearCopiedFeedback();
  flushPendingAutoCopy();
  scheduleCopyAfterIdle();
  void generate({ commit: false, copy: false });
}

async function onCredentialsCommit(explicitRow = null, { implicit = false } = {}) {
  window.clearTimeout(copyDebounceTimer);
  const row = explicitRow ?? (implicit ? rowForImplicitCommit() : rowForExplicitCommit());
  if (!row) {
    if (implicit && readyToGenerate()) {
      await generate({ commit: false, copy: false });
      return;
    }
    clearPasswordOutput();
    return;
  }
  commitRow(row);
  if (!readyToGenerate()) {
    clearPasswordOutput();
    return;
  }
  await generate({ commit: false, copy: true });
}

function clearPasswordOutput() {
  copyWhenReady = false;
  passwordText = "";
  lastAutoCopiedPassword = "";
  pendingAutoCopyText = "";
  copyButton.hidden = true;
  if (keyIsLocked()) {
    result.hidden = false;
    setLockedResult(true);
    passwordEl.textContent = unlockPromise ? UNLOCKING_TEXT : LOCKED_TEXT;
    passwordEl.classList.add("pending");
    return;
  }
  if (passwordEl.classList.contains("locked")) passwordEl.textContent = "";
  setLockedResult(false);
  result.hidden = true;
}

function setLockedResult(locked) {
  passwordEl.classList.toggle("locked", locked);
  if (locked) {
    passwordEl.setAttribute("role", "button");
    passwordEl.tabIndex = 0;
  } else {
    passwordEl.removeAttribute("role");
    passwordEl.removeAttribute("tabindex");
  }
}

async function generate({ commit = false, copy = false } = {}) {
  if (!readyToGenerate() || keyIsLocked()) {
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
    setLockedResult(false);
    passwordEl.textContent = "Deriving…";
    passwordEl.classList.add("pending");
    copyButton.hidden = true;
    passwordText = "";
  }
  try {
    const master = await masterKey();
    if (serial !== generateSerial) return;
    const password = await passwordFromMaster(master, row.key, siteVersion(row.key));
    if (serial !== generateSerial) return;
    passwordText = password;
    result.hidden = false;
    setLockedResult(false);
    passwordEl.textContent = password;
    passwordEl.classList.remove("pending");
    copyButton.hidden = false;
    if (copy || copyWhenReady) {
      copyWhenReady = false;
      await autoCopyPassword(password);
    }
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
    if (pendingDerive?.phrase !== phrase) {
      const promise = deriveSessionKey(phrase);
      pendingDerive = { phrase, promise };
      promise
        .finally(() => {
          if (pendingDerive?.promise === promise) pendingDerive = null;
        })
        .catch(() => {});
    }
    return pendingDerive.promise;
  }
  if (sessionKey) return sessionKey;
  if (hasSavedKey()) throw new Error(`${LOCKED_TEXT}.`);
  throw new Error("Enter a passphrase first.");
}

/** One Argon2id run per phrase; callers asking for the same phrase share it. */
async function deriveSessionKey(phrase) {
  const derived = await deriveMasterKey(phrase);
  wipe(sessionKey);
  sessionKey = derived;
  sessionPhrase = phrase;
  sessionFromSaved = false;
  if (rememberEnabled()) await rememberDerivedKey(derived);
  return derived;
}

async function rememberDerivedKey(key) {
  let saved = false;
  try {
    saved = await saveMasterKey(key);
  } catch (error) {
    showError(error?.cancelled
      ? "Passphrase not saved because Face ID was cancelled."
      : `Passphrase not saved. ${errorText(error, "")}`.trim());
    return;
  }
  if (!saved || sessionKey !== key) return;
  phraseInput.value = "";
  sessionPhrase = "";
  sessionFromSaved = true;
  updatePassphraseFieldState();
}

async function performAutoCopy(text) {
  if (!text || text === lastAutoCopiedPassword) return false;
  const ok = await writeClipboard(text);
  if (!ok) {
    pendingAutoCopyText = text;
    return false;
  }
  lastAutoCopiedPassword = text;
  pendingAutoCopyText = "";
  showCopiedFeedback();
  return true;
}

async function autoCopyPassword(text) {
  await performAutoCopy(text);
}

async function copyPassword(text) {
  pendingAutoCopyText = "";
  lastAutoCopiedPassword = text;
  await copyToClipboardWithFeedback(text);
}

async function copyToClipboardWithFeedback(text) {
  const ok = await writeClipboard(text);
  if (ok) showCopiedFeedback();
}

function showCopiedFeedback() {
  copyButton.classList.add("is-copied");
  copyButton.setAttribute("aria-label", "Copied to clipboard");
  copyDoneEl.hidden = false;
  window.clearTimeout(copiedFeedbackTimer);
  copiedFeedbackTimer = window.setTimeout(() => {
    clearCopiedFeedback();
  }, 5000);
}

function clearCopiedFeedback() {
  if (!copyButton.classList.contains("is-copied")) return;
  window.clearTimeout(copiedFeedbackTimer);
  copiedFeedbackTimer = 0;
  copyButton.classList.remove("is-copied");
  copyButton.setAttribute("aria-label", "Copy password");
  copyDoneEl.hidden = true;
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return copyWithHiddenTextarea(text);
  }
}

function copyWithHiddenTextarea(text) {
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.setAttribute("aria-hidden", "true");
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.left = "0";
    area.style.width = "2em";
    area.style.height = "2em";
    area.style.padding = "0";
    area.style.border = "0";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
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

function shouldSuppressMenuAutoHighlight() {
  if (manualActive != null) return false;
  if (!dismissedExactKey) return false;
  const row = rowForInput(siteInput.value);
  return row?.kind === "exact" && row.key === dismissedExactKey;
}

function commitRow(row) {
  dismissExactRowIfNeeded(row);
  pinRow(row);
  if (row.kind !== "exact") dismissedExactKey = null;
  if (row.kind !== "exact" && siteInput.value !== row.name) siteInput.value = row.name;
  renderMenu();
  suppressSiteBlurCommit = true;
  siteInput.blur();
  window.setTimeout(() => {
    suppressSiteBlurCommit = false;
  }, 0);
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
  let menu = applyDismissedExact(buildMenu(siteInput.value));
  if (shouldSuppressMenuAutoHighlight()) {
    menu = { ...menu, active: -1 };
  }
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

function appendMenuTextSpan(parent, text, muted, className = "") {
  if (!text) return;
  const span = document.createElement("span");
  span.className = muted ? "menu-match-muted" : "menu-match-hit";
  if (className) span.classList.add(className);
  span.textContent = text;
  parent.appendChild(span);
}

function appendHighlightedSiteName(parent, name, query) {
  const range = matchHighlightRange(name, query);
  if (!range) {
    appendMenuTextSpan(parent, name, Boolean(String(query ?? "").trim()));
    return;
  }
  appendMenuTextSpan(parent, name.slice(0, range.start), true);
  appendMenuTextSpan(parent, name.slice(range.start, range.end), false);
  appendMenuTextSpan(parent, name.slice(range.end), true);
}

function setMenuButtonLabel(button, row, query) {
  const trimmedQuery = String(query ?? "").trim();
  const plain = row.kind === "exact"
    ? `Use “${row.name}”`
    : (row.matchHost ? `${row.name} · ${row.matchHost}` : row.name);
  button.setAttribute(
    "aria-label",
    row.kind === "exact"
      ? `Use ${row.name}`
      : (row.matchHost ? `${row.name}, ${row.matchHost}` : row.name),
  );

  if (!trimmedQuery) {
    button.textContent = plain;
    return;
  }

  button.replaceChildren();
  if (row.kind === "exact") {
    appendMenuTextSpan(button, "Use “", true);
    appendHighlightedSiteName(button, row.name, trimmedQuery);
    appendMenuTextSpan(button, "”", true);
    return;
  }
  if (row.matchHost) {
    appendMenuTextSpan(button, row.name, true);
    appendMenuTextSpan(button, "·", true, "menu-suggestion-divider");
    appendHighlightedSiteName(button, row.matchHost, trimmedQuery);
    return;
  }
  appendHighlightedSiteName(button, row.name, trimmedQuery);
}

function renderMenu() {
  const menu = currentMenu();
  const menuQuery = siteInput.value;
  const hasSuggestions = menu.rows.length > 0;
  siteField.classList.toggle("has-suggestions", hasSuggestions);
  menuLabel.hidden = !menu.label;
  menuLabel.textContent = menu.label || "";
  menuList.replaceChildren();
  siteInput.setAttribute("aria-expanded", hasSuggestions ? "true" : "false");
  const activeId = menu.active >= 0 ? `opt-${menu.active}` : "";
  if (activeId) siteInput.setAttribute("aria-activedescendant", activeId);
  else siteInput.removeAttribute("aria-activedescendant");

  syncSiteClear();
  renderVersion();

  menu.rows.forEach((row, index) => {
    const item = document.createElement("li");
    item.setAttribute("role", "presentation");
    const button = document.createElement("button");
    button.type = "button";
    button.id = `opt-${index}`;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", index === menu.active ? "true" : "false");
    button.className = row.kind === "exact" ? "exact" : "";
    setMenuButtonLabel(button, row, menuQuery);
    const choose = (event) => {
      if (event) event.preventDefault();
      void onCredentialsCommit(row);
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

function readSiteVersions() {
  try {
    const map = JSON.parse(localStorage.getItem(SITE_VERSIONS_KEY) || "{}");
    return map && typeof map === "object" && !Array.isArray(map) ? map : {};
  } catch {
    return {};
  }
}

/** Per-site counter. Only sites moved off v1 are stored. */
function siteVersion(key) {
  if (!key) return DEFAULT_SITE_VERSION;
  try {
    return normalizeSiteVersion(readSiteVersions()[key] ?? DEFAULT_SITE_VERSION);
  } catch {
    return DEFAULT_SITE_VERSION;
  }
}

function setSiteVersion(key, version) {
  const map = readSiteVersions();
  if (version === DEFAULT_SITE_VERSION) delete map[key];
  else map[key] = version;
  try {
    localStorage.setItem(SITE_VERSIONS_KEY, JSON.stringify(map));
  } catch {
    showError("Could not save the version on this device.");
  }
}

function activeSiteKey() {
  return rowForInput(siteInput.value)?.key ?? null;
}

function renderVersion() {
  const key = activeSiteKey();
  const version = siteVersion(key);
  versionBtn.textContent = `v${version}`;
  versionBtn.disabled = !key;
  versionBtn.setAttribute("aria-label", `Password version ${version}`);
  if (!key) closeVersionMenu();
}

function openVersionMenu() {
  const key = activeSiteKey();
  if (!key) return;
  const current = siteVersion(key);
  versionMenu.replaceChildren();
  for (let version = 1; version <= current + 1; version += 1) {
    const item = document.createElement("li");
    item.setAttribute("role", "presentation");
    const option = document.createElement("button");
    option.type = "button";
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", version === current ? "true" : "false");
    const label = document.createElement("span");
    label.textContent = `v${version}`;
    option.append(label);
    const noteText = version === current ? "current" : version === current + 1 ? "new" : "";
    if (noteText) {
      const note = document.createElement("span");
      note.className = "version-note";
      note.textContent = noteText;
      option.append(note);
    }
    option.addEventListener("click", () => chooseVersion(key, version));
    item.append(option);
    versionMenu.append(item);
  }
  versionMenu.hidden = false;
  versionBtn.setAttribute("aria-expanded", "true");
}

function closeVersionMenu() {
  if (versionMenu.hidden) return;
  versionMenu.hidden = true;
  versionBtn.setAttribute("aria-expanded", "false");
}

function chooseVersion(key, version) {
  closeVersionMenu();
  if (activeSiteKey() !== key) return;
  if (version !== siteVersion(key)) setSiteVersion(key, version);
  renderVersion();
  window.clearTimeout(copyDebounceTimer);
  void generate({ commit: false, copy: true });
}

versionBtn.addEventListener("click", () => {
  if (versionMenu.hidden) openVersionMenu();
  else closeVersionMenu();
});

versionMenu.addEventListener("keydown", (event) => {
  const options = [...versionMenu.querySelectorAll("button")];
  const index = options.indexOf(document.activeElement);
  if (event.key === "Escape") {
    event.preventDefault();
    closeVersionMenu();
    versionBtn.focus();
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    options[(index + step + options.length) % options.length]?.focus();
  }
});

versionBtn.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowDown" || versionBtn.disabled) return;
  event.preventDefault();
  openVersionMenu();
  versionMenu.querySelector('[aria-selected="true"]')?.focus();
});

document.addEventListener("pointerdown", (event) => {
  if (!versionPicker.contains(event.target)) closeVersionMenu();
}, true);

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

function readStored(key) {
  return withStore("readonly", (store) => store.get(key));
}

function writeStored(key, value) {
  return withStore("readwrite", (store) => store.put(value, key));
}

function deleteStored(key) {
  return withStore("readwrite", (store) => store.delete(key));
}

function isCurrentRecord(record) {
  return record?.v === RECORD_VERSION
    && record.credentialId instanceof Uint8Array
    && record.prfSalt instanceof Uint8Array;
}

/** Turning Remember on makes a passkey and saves the current key under it. */
async function enableRemember() {
  const enrolled = await enrollPasskey();
  const record = enrolled.record;
  if (!rememberInput.checked) {
    signalUnknownCredential(record.credentialId);
    return;
  }
  const previous = savedRecord;
  prfWrap = { credentialId: record.credentialId, key: enrolled.key };
  const phrase = phraseInput.value.normalize("NFC");
  const key = sessionKey && (!phrase || phrase === sessionPhrase) ? sessionKey : null;
  const next = key
    ? { ...record, format: FORMAT_VERSION, ...(await sealMasterKey(key, enrolled.key)) }
    : record;
  await writeStored(RECORD, next);
  savedRecord = next;
  if (key && sessionKey === key) {
    sessionFromSaved = true;
    phraseInput.value = "";
    sessionPhrase = "";
  }
  if (previous && !bytesEqual(previous.credentialId, record.credentialId)) {
    signalUnknownCredential(previous.credentialId);
  }
}

async function forgetSavedKey() {
  const record = savedRecord;
  savedRecord = null;
  prfWrap = null;
  sessionFromSaved = false;
  wipe(sessionKey);
  sessionKey = null;
  sessionPhrase = "";
  if (record) signalUnknownCredential(record.credentialId);
  await deleteStored(RECORD);
}

/** Returns false when a newer key replaced this one before the save finished. */
async function saveMasterKey(bytes) {
  const plain = bytes.slice();
  try {
    if (rememberPromise) await rememberPromise.catch(() => {});
    const record = savedRecord;
    if (!record) throw new Error("Turn Remember on again.");
    const key = await wrapKeyFor(record);
    const sealed = await sealMasterKey(plain, key);
    const current = savedRecord;
    if (sessionKey !== bytes || !current || !bytesEqual(current.credentialId, record.credentialId)) {
      return false;
    }
    const next = {
      v: RECORD_VERSION,
      credentialId: record.credentialId,
      prfSalt: record.prfSalt,
      format: FORMAT_VERSION,
      ...sealed,
    };
    savedRecord = next;
    await writeStored(RECORD, next);
    return true;
  } finally {
    wipe(plain);
  }
}

/** One Face ID prompt per unlock; concurrent callers share it. */
function unlockSavedKey() {
  if (unlockPromise) return unlockPromise;
  const record = savedRecord;
  unlockPromise = wrapKeyFor(record)
    .then(async (key) => {
      let plain;
      try {
        plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: record.iv, additionalData: WRAP_INFO },
          key,
          record.ct,
        );
      } catch {
        if (savedRecord === record) {
          rememberInput.checked = false;
          await forgetSavedKey().catch(() => {});
          updatePassphraseFieldState();
        }
        throw new Error("The saved passphrase could not be unlocked, so it was removed. Enter it again.");
      }
      if (savedRecord !== record) throw new Error("Remember changed while unlocking. Try again.");
      wipe(sessionKey);
      sessionKey = new Uint8Array(plain);
      sessionPhrase = "";
      sessionFromSaved = true;
      updatePassphraseFieldState();
      return sessionKey;
    })
    .finally(() => {
      unlockPromise = null;
    });
  return unlockPromise;
}

/**
 * Calls navigator.credentials.get synchronously when no key is cached, so a
 * tap or keystroke that led here still counts as the user's gesture.
 */
function wrapKeyFor(record) {
  if (prfWrap && bytesEqual(prfWrap.credentialId, record.credentialId)) {
    return Promise.resolve(prfWrap.key);
  }
  return prfSecret(record.credentialId, record.prfSalt)
    .then(wrapKeyFromSecret)
    .then((key) => {
      prfWrap = { credentialId: record.credentialId, key };
      return key;
    });
}

async function enrollPasskey() {
  if (!window.PublicKeyCredential || !navigator.credentials?.create) {
    throw new Error(PRF_UNSUPPORTED);
  }
  const userId = passkeyUserId ?? crypto.getRandomValues(new Uint8Array(16));
  const prfSalt = crypto.getRandomValues(new Uint8Array(32));
  const credential = await callWebAuthn(() => navigator.credentials.create({
    publicKey: {
      rp: { name: "Password Generator" },
      // One stable handle per device, so turning Remember on again replaces
      // this device's passkey instead of piling up new ones.
      user: { id: userId, name: "Remembered passphrase", displayName: "Password Generator" },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        residentKey: "preferred",
        userVerification: "required",
      },
      hints: ["client-device"],
      attestation: "none",
      timeout: 120000,
      extensions: { prf: { eval: { first: prfSalt } } },
    },
  }));
  const credentialId = new Uint8Array(credential.rawId);
  try {
    if (!passkeyUserId) {
      passkeyUserId = userId;
      await writeStored(PASSKEY_USER, userId).catch(() => {});
    }
    const prf = credential.getClientExtensionResults?.().prf;
    let secret = prf?.results?.first ? new Uint8Array(prf.results.first) : null;
    if (!secret) {
      // Some platforms only report prf.enabled at registration; ask once more.
      if (prf?.enabled !== true) throw new Error(PRF_UNSUPPORTED);
      secret = await prfSecret(credentialId, prfSalt);
    }
    const key = await wrapKeyFromSecret(secret);
    return { record: { v: RECORD_VERSION, credentialId, prfSalt }, key };
  } catch (error) {
    signalUnknownCredential(credentialId);
    throw error;
  }
}

function prfSecret(credentialId, prfSalt) {
  return callWebAuthn(() => navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: "public-key", id: credentialId, transports: ["internal"] }],
      userVerification: "required",
      hints: ["client-device"],
      timeout: 120000,
      extensions: { prf: { eval: { first: prfSalt } } },
    },
  })).then((credential) => {
    const first = credential.getClientExtensionResults?.().prf?.results?.first;
    if (!first) throw new Error(PRF_UNSUPPORTED);
    return new Uint8Array(first);
  });
}

async function callWebAuthn(run) {
  let credential;
  try {
    credential = await run();
  } catch (error) {
    const name = error?.name;
    if (name === "NotAllowedError" || name === "AbortError") {
      const cancelled = new Error("Face ID was cancelled.");
      cancelled.cancelled = true;
      throw cancelled;
    }
    if (name === "NotSupportedError" || name === "SecurityError" || error instanceof TypeError) {
      throw new Error(PRF_UNSUPPORTED);
    }
    throw new Error(errorText(error, "Face ID failed."));
  }
  if (!credential) throw new Error("No passkey was returned.");
  return credential;
}

async function wrapKeyFromSecret(secret) {
  try {
    const ikm = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
    return await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: WRAP_INFO },
      ikm,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } finally {
    wipe(secret);
  }
}

async function sealMasterKey(bytes, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: WRAP_INFO },
    key,
    bytes,
  );
  return { iv, ct: new Uint8Array(ct) };
}

/** Best effort: asks the platform to delete a passkey this app no longer uses. */
function signalUnknownCredential(credentialId) {
  try {
    const signal = window.PublicKeyCredential?.signalUnknownCredential;
    if (typeof signal !== "function") return;
    signal.call(window.PublicKeyCredential, {
      rpId: location.hostname,
      credentialId: base64url(credentialId),
    }).catch(() => {});
  } catch {
    /* unsupported */
  }
}

function base64url(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function errorText(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}
