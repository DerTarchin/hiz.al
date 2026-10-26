/**
 * Internal site security tiers for catalog.json (not shown in UI).
 * Edit tier overrides here when heuristics mis-classify a site.
 */

export const SECURITY_TIER_ORDER = ["high", "medium", "low"];

const HIGH_KEYS = new Set([
  "ally",
  "alpaca",
  "apple",
  "barclays",
  "biltrewards",
  "bill",
  "carta",
  "cash app",
  "chase",
  "citi",
  "citizens",
  "comenity",
  "connectyourcare",
  "credit karma",
  "dwolla",
  "empower retirement",
  "equifax",
  "etrade",
  "experian",
  "fidelity",
  "freetaxusa",
  "gmail",
  "google",
  "icloud",
  "irs",
  "jpmorgan",
  "login.gov",
  "marcus",
  "nelnet",
  "paypal",
  "pnc",
  "robinhood",
  "schwab",
  "slavic401k",
  "social security",
  "studentaid",
  "synchrony",
  "syf",
  "td bank",
  "transunion",
  "turbotax",
  "venmo",
  "wageworks",
  "wells fargo",
  "westernunion",
  "zelle",
  "adp",
  "invoicecloud",
  "paymentworks",
  "privacy",
]);

const MEDIUM_KEYS = new Set([
  "adobe",
  "airbnb",
  "aliexpress",
  "amazon",
  "american airlines",
  "atlassian",
  "auth0",
  "autodesk",
  "aws",
  "best buy",
  "bitbucket",
  "chewy",
  "costco",
  "craigslist",
  "delta",
  "discord",
  "disney",
  "dominos",
  "dropbox",
  "ebay",
  "etsy",
  "expedia",
  "facebook",
  "github",
  "grubhub",
  "homedepot",
  "hulu",
  "imdb",
  "indeed",
  "instacart",
  "investing",
  "instagram",
  "linkedin",
  "lyft",
  "macys",
  "microsoft",
  "monarchmoney",
  "netflix",
  "notion",
  "offerup",
  "openai",
  "chatgpt",
  "outlook",
  "pinterest",
  "priceline",
  "reddit",
  "ring",
  "samsung",
  "shopify",
  "slack",
  "sony",
  "southwest",
  "spotify",
  "starbucks",
  "steam",
  "stubhub",
  "target",
  "ticketmaster",
  "tiktok",
  "tradingview",
  "chubb",
  "turo",
  "uber",
  "united",
  "verizon",
  "walmart",
  "whatsapp",
  "x",
  "xfinity",
  "yahoo",
  "youtube",
  "zoom",
  "aetna",
  "cigna",
  "progressive",
  "zillow",
]);

/** @type {Record<string, "high" | "medium" | "low">} */
const TIER_OVERRIDES = {
  equityapartments: "low",
  monarchmoney: "medium",
};

const HIGH_HOST_RE =
  /(?:^|\.)(?:gov|mil)(?:\.|$)|login\.gov|irs\.gov|ssa\.gov|studentaid\.gov|pay\.gov|treasury\.gov/i;
const HIGH_TEXT_RE =
  /\b(bank|bancorp|credit union|brokerage|broker|401k|403b|ira|hsa|fsa|mortgage|lending|lender)\b/i;
const MEDIUM_TEXT_RE =
  /\b(shop|store|retail|marketplace|social|streaming|airlines|airline|hotels?|grub|delivery|e-?commerce)\b/i;

function hostBlob(entry) {
  return [entry.key, entry.name, ...entry.hosts, ...(entry.aliases ?? [])].join(" ").toLowerCase();
}

/**
 * @param {{ key: string, name: string, hosts: string[], aliases?: string[] }} entry
 * @returns {"high" | "medium" | "low"}
 */
export function classifySiteSecurity(entry) {
  const key = entry.key.toLowerCase();
  if (TIER_OVERRIDES[key]) return TIER_OVERRIDES[key];
  if (HIGH_KEYS.has(key)) return "high";
  if (MEDIUM_KEYS.has(key)) return "medium";

  const blob = hostBlob(entry);
  for (const host of entry.hosts) {
    if (HIGH_HOST_RE.test(host)) return "high";
  }
  if (HIGH_TEXT_RE.test(blob)) return "high";
  if (MEDIUM_TEXT_RE.test(blob)) return "medium";

  if (
    /\b(facebook|instagram|linkedin|twitter|tiktok|snapchat|pinterest|reddit|discord|tumblr)\b/.test(blob)
  ) {
    return "medium";
  }
  if (/\b(amazon|walmart|target|costco|ebay|etsy|bestbuy|homedepot|macys|chewy)\b/.test(blob)) {
    return "medium";
  }

  return "low";
}

export function tierRank(tier) {
  const index = SECURITY_TIER_ORDER.indexOf(tier);
  return index === -1 ? SECURITY_TIER_ORDER.length : index;
}

export function compareSitesBySecurity(a, b) {
  const byTier = tierRank(a.security) - tierRank(b.security);
  if (byTier !== 0) return byTier;
  return a.key.localeCompare(b.key, "en", { sensitivity: "base" });
}
