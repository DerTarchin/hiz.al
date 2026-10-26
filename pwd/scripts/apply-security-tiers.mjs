/**
 * Assign security tiers and reorder catalog.json sites (high → medium → low).
 * Run: node scripts/apply-security-tiers.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSiteRegistry } from "../site-registry.js";
import {
  classifySiteSecurity,
  compareSitesBySecurity,
  SECURITY_TIER_ORDER,
} from "./security-tiers.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const jsonPath = join(root, "catalog.json");
const catalog = JSON.parse(readFileSync(jsonPath, "utf8"));

const sites = catalog.sites.map((entry) => ({
  ...entry,
  security: classifySiteSecurity(entry),
}));

sites.sort(compareSitesBySecurity);

const ordered = {
  schema: catalog.schema,
  revision: catalog.revision,
  securityTierOrder: SECURITY_TIER_ORDER,
  favorites: catalog.favorites,
  compoundSuffixes: catalog.compoundSuffixes,
  hostPrefixes: catalog.hostPrefixes,
  sites,
};

createSiteRegistry(ordered);

const counts = { high: 0, medium: 0, low: 0 };
for (const site of sites) counts[site.security] += 1;

writeFileSync(jsonPath, `${JSON.stringify(ordered, null, 2)}\n`);
console.log("security tiers applied", counts);
