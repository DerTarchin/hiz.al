import fallbackCatalog from "./catalog.json" with { type: "json" };
import {
  buildMenu,
  cleanHostInput,
  createSiteRegistry,
  fetchSiteCatalog,
  getSiteRegistry,
  matchHighlightRange,
  rowForInput,
  setSiteRegistry,
} from "./site-registry.js";

const STORAGE_KEY = "hizPwdSiteCatalog";
const TTL_MS = 60 * 60 * 1000;

setSiteRegistry(createSiteRegistry(fallbackCatalog));
applyStoredCatalog();

export {
  buildMenu,
  cleanHostInput,
  matchHighlightRange,
  rowForInput,
};

export async function loadSiteCatalog() {
  const stored = readStored();
  if (stored?.catalog && Date.now() - stored.fetchedAt < TTL_MS) {
    applyCatalog(stored.catalog);
    return stored.catalog;
  }

  try {
    const result = await fetchSiteCatalog({
      gzipUrl: new URL("./catalog.json.gz", import.meta.url).href,
      jsonUrl: new URL("./catalog.json", import.meta.url).href,
      etag: stored?.etag || "",
    });
    if (result.notModified && stored?.catalog) {
      writeStored({ ...stored, fetchedAt: Date.now(), etag: result.etag || stored.etag || "" });
      applyCatalog(stored.catalog);
      return stored.catalog;
    }
    const current = getSiteRegistry().revision;
    if (result.catalog.revision >= current) {
      setSiteRegistry(createSiteRegistry(result.catalog));
      writeStored({
        catalog: result.catalog,
        fetchedAt: Date.now(),
        etag: result.etag || "",
      });
      return result.catalog;
    }
    writeStored({
      catalog: stored?.catalog && stored.catalog.revision >= current ? stored.catalog : fallbackCatalog,
      fetchedAt: Date.now(),
      etag: result.etag || stored?.etag || "",
    });
    return fallbackCatalog;
  } catch {
    return stored?.catalog ?? fallbackCatalog;
  }
}

function applyStoredCatalog() {
  const stored = readStored();
  if (!stored?.catalog) return;
  applyCatalog(stored.catalog);
}

function applyCatalog(catalog) {
  try {
    if (catalog.revision < getSiteRegistry().revision) return;
    if (catalog.revision === getSiteRegistry().revision) return;
    setSiteRegistry(createSiteRegistry(catalog));
  } catch {
    /* keep the catalog already installed */
  }
}

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw);
    if (!stored?.catalog || typeof stored.fetchedAt !== "number") return null;
    return stored;
  } catch {
    return null;
  }
}

function writeStored(stored) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    /* private mode or quota */
  }
}
