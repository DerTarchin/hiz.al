import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSiteRegistry } from "../site-registry.js";
import { SECURITY_TIER_ORDER, tierRank } from "./security-tiers.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(readFileSync(join(root, "catalog.json"), "utf8"));

createSiteRegistry(catalog);

if (JSON.stringify(catalog.securityTierOrder) !== JSON.stringify(SECURITY_TIER_ORDER)) {
  throw new Error("securityTierOrder mismatch");
}

let lastRank = -1;
for (const site of catalog.sites) {
  const rank = tierRank(site.security);
  if (rank < lastRank) throw new Error(`sites out of tier order at ${site.key}`);
  lastRank = rank;
}

const counts = Object.fromEntries(SECURITY_TIER_ORDER.map((tier) => [tier, 0]));
for (const site of catalog.sites) counts[site.security] += 1;

console.log("security tiers ok", counts);
