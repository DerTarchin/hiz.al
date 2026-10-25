/**
 * Derivation format v2. The pinned vectors must match the Chrome extension's
 * scripts/test-crypto.mjs; if either side changes, every password changes.
 *
 *   node scripts/test-derive.mjs
 */
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
await import(pathToFileURL(join(root, "argon2.js")).href);
const {
  EntropyExhaustedError,
  KDF,
  deriveMasterKey,
  encodeFromStream,
  encodePassword,
  normalizeSiteVersion,
  passwordFromMaster,
} = await import(pathToFileURL(join(root, "derive.js")).href);

let failures = 0;
function check(condition, message) {
  console.log(`  ${condition ? "ok  " : "FAIL"} ${message}`);
  if (!condition) failures += 1;
}

const VECTORS = [
  ["test-passphrase", "amazon", 1, "EhQD!pe0yi80VsnVt"],
  ["test-passphrase", "amazon", 2, "08MQKwQCHVr!F1sdJ"],
  ["test-passphrase", "wells fargo", 1, "lS7o!ftVoC7aSzYEH"],
  ["correct horse battery staple", "chase", 1, "Sz2MQ2CYC!FZvoLdc"],
];

console.log("KDF parameters");
check(KDF.memorySize === 65536 && KDF.iterations === 3 && KDF.parallelism === 1, "Argon2id 64 MiB, 3 passes, 1 lane");

console.log("Pinned vectors");
const masters = new Map();
for (const [phrase, site, version, expected] of VECTORS) {
  if (!masters.has(phrase)) masters.set(phrase, await deriveMasterKey(phrase));
  const password = await passwordFromMaster(masters.get(phrase), site, version);
  check(password === expected, `${site} v${version} -> ${password}`);
}

console.log("Per-site version");
const master = masters.get("test-passphrase");
const seen = new Set();
for (let version = 1; version <= 20; version += 1) {
  seen.add(await passwordFromMaster(master, "amazon", version));
}
check(seen.size === 20, "versions 1-20 give 20 different passwords");
check(await passwordFromMaster(master, "amazon") === await passwordFromMaster(master, "amazon", 1), "version defaults to 1");
for (const bad of [0, -1, 1.5, 1000, "two", null]) {
  let threw = false;
  try {
    normalizeSiteVersion(bad);
  } catch {
    threw = true;
  }
  check(threw, `rejects version ${JSON.stringify(bad)}`);
}

console.log("Encoder shape");
let shapeOk = true;
for (let i = 0; i < 20000; i += 1) {
  const password = encodePassword(new Uint8Array(randomBytes(64)));
  if (password.length !== 17 || !/[a-z]/.test(password) || !/[A-Z]/.test(password)
    || !/[0-9]/.test(password) || (password.match(/!/g) || []).length !== 1) {
    shapeOk = false;
    break;
  }
}
check(shapeOk, "17 chars with lower, upper, digit, and exactly one !");

console.log("Entropy exhaustion");
let exhausted64 = 0;
const samples = 500000;
for (let i = 0; i < samples; i += 1) {
  try {
    encodePassword(new Uint8Array(randomBytes(64)));
  } catch {
    exhausted64 += 1;
  }
}
check(exhausted64 === 0, `no 64-byte stream ran out in ${samples} tries`);

let short = null;
for (let i = 0; i < 2000000 && !short; i += 1) {
  const candidate = new Uint8Array(randomBytes(32));
  try {
    encodePassword(candidate);
  } catch (error) {
    if (error instanceof EntropyExhaustedError) short = candidate;
  }
}
check(Boolean(short), "found a 32-byte stream that runs out (the old failure)");
if (short) {
  const longer = new Uint8Array(64);
  longer.set(short);
  longer.set(randomBytes(32), 32);
  check(encodePassword(longer).length === 17, "the same stream with more bytes now encodes");
}

const stream = new Uint8Array(randomBytes(256));
check(encodePassword(stream.subarray(0, 64)) === encodePassword(stream), "a longer stream gives the same password");

const stuck = new Uint8Array(4096).fill(0xff);
stuck.set(randomBytes(4096 - 64), 64);
const lengths = [];
const grown = await encodeFromStream(async (length) => {
  lengths.push(length);
  return stuck.subarray(0, length);
});
check(grown.length === 17 && lengths.join(",") === "64,128", `fallback reads 128 bytes when 64 run out (${lengths.join(",")})`);

let capped = false;
try {
  await encodeFromStream(async (length) => new Uint8Array(length).fill(0xff));
} catch (error) {
  capped = error instanceof EntropyExhaustedError;
}
check(capped, "an all-rejecting stream stops at the HKDF output limit");

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nderive ok");
