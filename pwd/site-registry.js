/**
 * Site lookup shared by hiz.al/pwd and the Chrome extension.
 * Catalog data lives in catalog.json. Changing a site key or host mapping
 * changes every password derived for that site.
 */

export const CATALOG_SCHEMA = 1;

const SUGGESTION_LIMIT = 3;

let current = null;

export function normalizeCatalog(raw) {
  if (!raw || raw.schema !== CATALOG_SCHEMA) {
    throw new Error("Unsupported site catalog schema");
  }
  if (!Number.isInteger(raw.revision) || raw.revision < 1) {
    throw new Error("Invalid site catalog revision");
  }
  if (!Array.isArray(raw.sites) || raw.sites.length === 0) {
    throw new Error("Site catalog is empty");
  }
  if (!Array.isArray(raw.favorites)) throw new Error("Site catalog missing favorites");
  if (!Array.isArray(raw.compoundSuffixes) || !Array.isArray(raw.hostPrefixes)) {
    throw new Error("Site catalog missing host rules");
  }

  const sites = raw.sites.map((entry) => {
    if (!entry || typeof entry.name !== "string" || typeof entry.key !== "string") {
      throw new Error("Invalid site entry");
    }
    if (!Array.isArray(entry.hosts) || entry.hosts.length === 0) {
      throw new Error(`Invalid hosts for ${entry.key}`);
    }
    return {
      name: entry.name,
      key: entry.key.toLowerCase(),
      hosts: entry.hosts.map((host) => String(host).toLowerCase()),
      aliases: Array.isArray(entry.aliases)
        ? entry.aliases.map((alias) => String(alias).toLowerCase())
        : [],
    };
  });

  return {
    schema: raw.schema,
    revision: raw.revision,
    favorites: raw.favorites.map((key) => String(key).toLowerCase()),
    compoundSuffixes: raw.compoundSuffixes.map((suffix) => String(suffix).toLowerCase()),
    hostPrefixes: raw.hostPrefixes.map((prefix) => String(prefix).toLowerCase()),
    sites,
  };
}

export function createSiteRegistry(catalog) {
  const normalized = normalizeCatalog(catalog);
  const { sites } = normalized;
  const compoundSuffixes = new Set(normalized.compoundSuffixes);
  const hostPrefixes = new Set(normalized.hostPrefixes);
  const hostIndex = new Map();
  const keyIndex = new Map();

  for (const entry of sites) {
    if (keyIndex.has(entry.key)) {
      throw new Error(`Duplicate site key: ${entry.key}`);
    }
    keyIndex.set(entry.key, entry);
    for (const host of entry.hosts) hostIndex.set(host, entry);
  }

  const favorites = normalized.favorites.map((key) => {
    const entry = keyIndex.get(key);
    if (!entry) throw new Error(`Missing favorite: ${key}`);
    return entry;
  });

  function compoundSuffixSize(labels) {
    if (labels.length >= 2 && compoundSuffixes.has(labels.slice(-2).join("."))) return 2;
    return 1;
  }

  function siteFromHost(host) {
    let labels = String(host ?? "").toLowerCase().split(".").filter(Boolean);
    while (labels.length > 2 && hostPrefixes.has(labels[0])) labels = labels.slice(1);
    for (let i = 0; i < labels.length; i += 1) {
      const hit = hostIndex.get(labels.slice(i).join("."));
      if (hit) return hit;
    }
    const suffix = compoundSuffixSize(labels);
    const nameIndex = labels.length - suffix - 1;
    const label = (labels[nameIndex] || labels[0] || "").replace(/-/g, " ");
    const known = keyIndex.get(label.toLowerCase());
    if (known) return known;
    const name = titleCase(label);
    return { name, key: name.toLowerCase(), hosts: [], aliases: [], adhoc: true };
  }

  function cleanHostInput(raw) {
    const host = extractHost(raw);
    if (!host) return null;
    return siteFromHost(host).name;
  }

  function resolveExact(raw) {
    const name = String(raw ?? "").trim().replace(/\s+/g, " ").normalize("NFC");
    const lower = name.toLowerCase();
    if (!lower) return null;
    const known = sites.find((entry) =>
      entry.name.toLowerCase() === lower
      || entry.key === lower
      || entry.aliases.includes(lower),
    );
    if (known) return { kind: "site", name: known.name, key: known.key, known: true };
    return { kind: "exact", name, key: lower, known: false };
  }

  function searchSites(raw) {
    const q = String(raw ?? "").trim().replace(/\s+/g, " ").toLowerCase();
    if (!q) return [];

    const prefixScored = [];
    for (const entry of sites) {
      const matchedWordLength = shortestWordPrefixMatch(entry, q);
      if (matchedWordLength == null) continue;
      prefixScored.push([matchedWordLength, entry]);
    }
    sortSiteMatches(prefixScored);
    const results = prefixScored.slice(0, SUGGESTION_LIMIT).map((item) => item[1]);
    if (results.length >= SUGGESTION_LIMIT) return results;

    const seen = new Set(results.map((entry) => entry.key));
    const infixScored = [];
    for (const entry of sites) {
      if (seen.has(entry.key)) continue;
      const matchedWordLength = shortestWordInfixMatch(entry, q);
      if (matchedWordLength == null) continue;
      infixScored.push([matchedWordLength, entry]);
    }
    sortSiteMatches(infixScored);
    for (const [, entry] of infixScored) {
      if (results.length >= SUGGESTION_LIMIT) break;
      results.push(entry);
      seen.add(entry.key);
    }
    return results;
  }

  function siteMatchesQueryExactly(entry, raw) {
    const q = String(raw ?? "").trim().replace(/\s+/g, " ").toLowerCase();
    if (!q) return false;
    return entry.name.toLowerCase() === q
      || entry.key === q
      || entry.aliases.includes(q);
  }

  function buildMenu(raw) {
    const original = String(raw ?? "").trim();
    if (!original) {
      return {
        label: null,
        rows: favorites.map((entry) => asSiteRow(entry)),
        active: -1,
      };
    }
    const exact = resolveExact(original);
    let matches = searchSites(original).filter((entry) => !siteMatchesQueryExactly(entry, original));
    const cleanedName = cleanHostInput(original);
    if (cleanedName) {
      const cleaned = resolveExact(cleanedName);
      if (cleaned?.known && !matches.some((entry) => entry.key === cleaned.key)) {
        const entry = keyIndex.get(cleaned.key);
        if (entry && !siteMatchesQueryExactly(entry, original)) {
          matches.unshift(entry);
        }
      }
    }
    matches = matches.slice(0, SUGGESTION_LIMIT);
    const rows = matches.map((entry) => asSiteRow(entry, original));
    if (exact && !exact.known && !rows.some((row) => row.key === exact.key)) {
      rows.push({ kind: "exact", name: exact.name, key: exact.key });
    }
    let active = -1;
    const firstSiteIndex = rows.findIndex((row) => row.kind === "site");
    if (firstSiteIndex >= 0) {
      active = firstSiteIndex;
    } else if (!exact?.known) {
      active = rows.findIndex((row) => row.kind === "exact");
    }
    return { label: null, rows, active };
  }

  function rowForInput(raw) {
    const original = String(raw ?? "").trim();
    if (!original) return null;
    const exact = resolveExact(original);
    if (exact?.known) {
      return { kind: "site", name: exact.name, key: exact.key };
    }
    if (exact) {
      return { kind: "exact", name: exact.name, key: exact.key };
    }
    return null;
  }

  return {
    schema: normalized.schema,
    revision: normalized.revision,
    sites,
    favorites,
    siteFromHost,
    cleanHostInput,
    resolveExact,
    searchSites,
    buildMenu,
    rowForInput,
  };
}

export function setSiteRegistry(registry) {
  current = registry;
}

export function getSiteRegistry() {
  if (!current) throw new Error("Site catalog is not loaded");
  return current;
}

export function siteFromHost(host) {
  return getSiteRegistry().siteFromHost(host);
}

export function cleanHostInput(raw) {
  return getSiteRegistry().cleanHostInput(raw);
}

export function resolveExact(raw) {
  return getSiteRegistry().resolveExact(raw);
}

export function searchSites(raw) {
  return getSiteRegistry().searchSites(raw);
}

export function buildMenu(raw) {
  return getSiteRegistry().buildMenu(raw);
}

export function rowForInput(raw) {
  return getSiteRegistry().rowForInput(raw);
}

export function extractHost(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const domainish = hasScheme
    || /^www\./i.test(trimmed)
    || /^[^\s/]+\.[a-z]{2,}([/:?#]|$)/i.test(trimmed);
  if (!domainish) return null;
  let url;
  try {
    url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/\.$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!host.includes(".") || !/^[a-z0-9.-]+$/.test(host)) return null;
  return host;
}

/** Inclusive start, exclusive end in displayName; null if query empty or no overlap. */
export function matchHighlightRange(displayName, query) {
  const q = String(query ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!q) return null;
  const name = String(displayName ?? "");
  if (!name) return null;

  const lower = name.toLowerCase();
  if (lower.startsWith(q)) return { start: 0, end: q.length };

  const wordStart = findWordPrefixRange(name, q);
  if (wordStart) return wordStart;

  const index = lower.indexOf(q);
  if (index >= 0) return { start: index, end: index + q.length };

  let collapsed = "";
  const indexMap = [];
  for (let i = 0; i < name.length; i += 1) {
    const ch = name[i];
    if (/\s/.test(ch)) continue;
    indexMap.push(i);
    collapsed += ch.toLowerCase();
  }
  const start = collapsed.indexOf(q);
  if (start < 0) return null;
  const end = start + q.length;
  return { start: indexMap[start], end: indexMap[end - 1] + 1 };
}

export async function fetchSiteCatalog({ gzipUrl, jsonUrl, etag } = {}) {
  const attempts = [
    { url: gzipUrl, gzip: true },
    { url: jsonUrl, gzip: false },
  ];
  let lastError = null;
  for (const attempt of attempts) {
    if (!attempt.url) continue;
    try {
      const headers = {};
      if (etag) headers["If-None-Match"] = etag;
      const response = await fetch(attempt.url, { headers, cache: "no-cache" });
      if (response.status === 304) {
        return { notModified: true, etag: response.headers.get("etag") || etag || "" };
      }
      if (!response.ok) throw new Error(`Site catalog request failed (${response.status})`);
      const catalog = attempt.gzip ? await readGzipJson(response) : await response.json();
      return {
        catalog: normalizeCatalog(catalog),
        etag: response.headers.get("etag") || "",
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Could not fetch site catalog");
}

async function readGzipJson(response) {
  if (typeof DecompressionStream !== "function" || !response.body) {
    throw new Error("Gzip site catalog is not supported here");
  }
  const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
  const text = await new Response(stream).text();
  return JSON.parse(text);
}

function asSiteRow(entry, query = "") {
  const row = { kind: "site", name: entry.name, key: entry.key };
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return row;
  if (matchHighlightRange(entry.name, q)) return row;
  const host = bestMatchingHostForSuggestion(entry, q);
  if (host) row.matchHost = host;
  return row;
}

function siteSearchTokensCatalog(entry) {
  const tokens = [];
  const add = (text) => {
    const raw = String(text ?? "").trim().toLowerCase();
    if (!raw) return;
    tokens.push(raw);
    for (const part of raw.split(/[\s*/]+/)) {
      if (part) tokens.push(part);
    }
  };
  add(entry.name);
  add(entry.key);
  for (const alias of entry.aliases) add(alias);
  return tokens;
}

function bestMatchingHost(entry, q) {
  let best = null;
  for (const host of entry.hosts) {
    const label = host.split(".")[0].toLowerCase();
    if (!label.startsWith(q) && !label.includes(q)) continue;
    const rank = label.startsWith(q) ? label.length : label.length + 10_000;
    if (best == null || rank < best.rank) best = { host, rank };
  }
  return best?.host ?? null;
}

function bestMatchingHostForSuggestion(entry, q) {
  const fromHost = bestMatchingHost(entry, q);
  if (fromHost) return fromHost;
  for (const alias of entry.aliases) {
    const aliasLower = alias.toLowerCase();
    if (!aliasLower.startsWith(q) && !aliasLower.includes(q)) continue;
    const labelMatch = entry.hosts.find(
      (host) => host.split(".")[0].toLowerCase() === aliasLower,
    );
    if (labelMatch) return labelMatch;
    const prefixMatch = entry.hosts.find((host) => {
      const label = host.split(".")[0].toLowerCase();
      return label.startsWith(q) || label.includes(q);
    });
    if (prefixMatch) return prefixMatch;
    if (entry.hosts[0]) return entry.hosts[0];
  }
  return null;
}

function siteSearchTokens(entry) {
  const tokens = siteSearchTokensCatalog(entry);
  for (const host of entry.hosts) {
    const label = host.split(".")[0];
    if (label) tokens.push(label.toLowerCase());
  }
  return tokens;
}

function shortestWordPrefixMatch(entry, q) {
  let best = null;
  for (const token of siteSearchTokens(entry)) {
    if (!token.startsWith(q)) continue;
    if (best == null || token.length < best) best = token.length;
  }
  return best;
}

function shortestWordInfixMatch(entry, q) {
  let best = null;
  for (const token of siteSearchTokens(entry)) {
    if (!token.includes(q) || token.startsWith(q)) continue;
    if (best == null || token.length < best) best = token.length;
  }
  return best;
}

function findWordPrefixRange(name, q) {
  const pattern = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = name.match(new RegExp(`(^|[\\s*/])(${pattern})`, "i"));
  if (!match || match.index == null) return null;
  const start = match.index + match[1].length;
  return { start, end: start + q.length };
}

function sortSiteMatches(scored) {
  scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name));
}

function titleCase(value) {
  return value.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}
