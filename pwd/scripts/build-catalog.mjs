/**
 * Validate catalog.json, bump revision when the mapping data changed, and
 * write catalog.json.gz. Edit catalog.json only — do not edit revision or the
 * gzip by hand. Changing a site key or host mapping changes derived passwords.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSiteRegistry } from "../site-registry.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const jsonPath = join(root, "catalog.json");
const gzPath = join(root, "catalog.json.gz");

const catalog = JSON.parse(readFileSync(jsonPath, "utf8"));
const previous = readPreviousCatalog();
const changed = !previous || catalogContent(catalog) !== catalogContent(previous);

if (changed) {
  const from = Math.max(numberOrZero(catalog.revision), numberOrZero(previous?.revision));
  catalog.revision = nextRevision(from);
}

const registry = createSiteRegistry(catalog);
const body = `${JSON.stringify(catalog, null, 2)}\n`;
const gzip = gzipSync(Buffer.from(body));
writeFileSync(jsonPath, body);
writeFileSync(gzPath, gzip);

console.log(
  `catalog revision ${registry.revision}${changed ? " (bumped)" : ""}: ${registry.sites.length} sites, gzip ${gzip.length} bytes`,
);

function catalogContent(value) {
  return JSON.stringify({
    schema: value.schema,
    securityTierOrder: value.securityTierOrder,
    favorites: value.favorites,
    compoundSuffixes: value.compoundSuffixes,
    hostPrefixes: value.hostPrefixes,
    sites: value.sites,
  });
}

function readPreviousCatalog() {
  if (!existsSync(gzPath)) return null;
  try {
    return JSON.parse(gunzipSync(readFileSync(gzPath)).toString("utf8"));
  } catch {
    return null;
  }
}

function numberOrZero(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function nextRevision(current) {
  const now = new Date();
  const today = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
  const base = today * 100;
  if (current >= base && current < base + 99) return current + 1;
  return Math.max(current + 1, base + 1);
}
