const CACHE = "pwd-shell-37";
const ASSETS = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  "./derive.js",
  "./sites.js",
  "./argon2.js",
  "./manifest.json",
  "./favicon.ico",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-192-maskable.png",
  "./icon-512-maskable.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith("/pwd")) return;
  if (url.pathname.endsWith("/sw.js")) return;
  event.respondWith(cacheFirst(request));
});

async function precache() {
  const cache = await caches.open(CACHE);
  await Promise.all(ASSETS.map(async (url) => {
    try {
      await cache.add(url);
    } catch (error) {
      console.warn("precache skip", url, error);
    }
  }));
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) {
    revalidate(cache, request);
    return cached;
  }
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    if (request.mode === "navigate") {
      const fallback = await cache.match("./index.html");
      if (fallback) return fallback;
    }
    throw error;
  }
}

function revalidate(cache, request) {
  fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response);
    })
    .catch(() => {});
}
