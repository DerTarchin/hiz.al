const CACHE = "pwd-shell-52";
const NETWORK_TIMEOUT_MS = 2500;

// Only what the app needs to run offline. Icons and iOS splash screens (about
// 2.4 MB) are cached when they are first requested instead of on install, so
// a first visit on a slow network is not competing with them.
const ASSETS = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  "./derive.js",
  "./sites.js",
  "./site-registry.js",
  "./passphrase-fingerprint.js",
  "./catalog.json",
  "./catalog.json.gz",
  "./argon2.js",
  "./kdf-worker.js",
  "./fonts/kode-mono-latin-wght-normal.woff2",
  "./manifest.json",
  "./favicon.ico",
  "./apple-touch-icon.png",
];

const NAV_FALLBACK_KEYS = ["./index.html", "./", "./pwd/index.html"];

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(activate());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith("/pwd")) return;
  if (url.pathname.endsWith("/sw.js")) return;
  if (isCatalogRequest(url)) {
    event.respondWith(serveCatalog(request));
    return;
  }
  event.respondWith(serveShell(request));
});

// Only the background refresh (catalog.json.gz) goes to the network first. The
// catalog the app starts from (catalog.json) comes from the cache like the rest
// of the shell, so a repeat visit on a bad connection never waits on it.
function isCatalogRequest(url) {
  return url.pathname.endsWith("/catalog.json.gz");
}

async function serveCatalog(request) {
  try {
    const response = await fetchWithTimeout(request, NETWORK_TIMEOUT_MS);
    if (response.ok) {
      const cache = await caches.open(CACHE);
      cache.put(request, response.clone());
      return response;
    }
  } catch {
    /* use the precached catalog */
  }
  const cache = await caches.open(CACHE);
  const cached = await matchCached(cache, request);
  if (cached) return cached;
  return fetch(request);
}

async function activate() {
  const cache = await caches.open(CACHE);
  const hasShell = await cache.match("./index.html");
  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter((key) => key !== CACHE && hasShell)
      .map((key) => caches.delete(key)),
  );
  await self.clients.claim();
}

async function precache() {
  const cache = await caches.open(CACHE);
  await migratePreviousCache(cache);
  await Promise.all(ASSETS.map((url) => precacheOne(cache, url)));
}

async function migratePreviousCache(cache) {
  const keys = await caches.keys();
  const previous = keys
    .filter((key) => key.startsWith("pwd-shell-") && key !== CACHE)
    .sort()
    .pop();
  if (!previous) return;
  const oldCache = await caches.open(previous);
  await Promise.all(ASSETS.map(async (url) => {
    if (await cache.match(url)) return;
    const hit = await oldCache.match(url);
    if (hit) await cache.put(url, hit);
  }));
}

async function precacheOne(cache, url) {
  if (await cache.match(url)) return;
  try {
    const response = await fetchWithTimeout(url, 8000);
    if (response.ok) await cache.put(url, response);
  } catch (error) {
    console.warn("precache skip", url, error);
  }
}

function fetchWithTimeout(resource, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    fetch(resource)
      .then((response) => {
        clearTimeout(timer);
        resolve(response);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

async function matchCached(cache, request) {
  const direct = await cache.match(request);
  if (direct) return direct;

  const url = new URL(request.url);
  const file = url.pathname.split("/").pop() || "";
  const candidates = new Set();

  if (request.mode === "navigate" || file === "" || file === "pwd") {
    for (const key of NAV_FALLBACK_KEYS) candidates.add(key);
  }
  if (file) {
    candidates.add(`./${file}`);
    candidates.add(`/pwd/${file}`);
  }

  for (const key of candidates) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  return null;
}

async function serveShell(request) {
  const cache = await caches.open(CACHE);
  const cached = await matchCached(cache, request);
  if (cached) {
    revalidate(cache, request);
    return cached;
  }

  try {
    const response = await fetchWithTimeout(request, NETWORK_TIMEOUT_MS);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const fallback = await matchCached(cache, request)
      || (request.mode === "navigate" ? await cache.match("./index.html") : null);
    if (fallback) return fallback;
    throw error;
  }
}

function revalidate(cache, request) {
  fetchWithTimeout(request, NETWORK_TIMEOUT_MS)
    .then((response) => {
      if (response && response.ok) cache.put(request, response);
    })
    .catch(() => {});
}
