/**
 * Validate catalog.json and write catalog.json.gz for static hosting.
 * Edit catalog.json (and bump revision) — do not edit the gzip by hand.
 * Changing a site key or host mapping changes derived passwords.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSiteRegistry } from "../site-registry.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const jsonPath = join(root, "catalog.json");
const gzPath = join(root, "catalog.json.gz");

const catalog = JSON.parse(readFileSync(jsonPath, "utf8"));
const registry = createSiteRegistry(catalog);
const body = `${JSON.stringify(catalog, null, 2)}\n`;
const gzip = gzipSync(Buffer.from(body));
writeFileSync(jsonPath, body);
writeFileSync(gzPath, gzip);

console.log(
  `catalog revision ${registry.revision}: ${registry.sites.length} sites, gzip ${gzip.length} bytes`,
);
