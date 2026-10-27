/* Keep APP_SALT and KDF in sync with derive.js */
importScripts("argon2.js");

const APP_SALT = "hiz.al/pwd.v2!!!";
const KDF = {
  memorySize: 65536,
  iterations: 3,
  parallelism: 1,
  hashLength: 32,
};

let jobChain = Promise.resolve();

async function runKdfJob(data) {
  const { id, phrase, probe } = data ?? {};
  if (probe) {
    self.postMessage({ id, ok: true, probe: true });
    return;
  }
  try {
    const fn = self.hashwasm?.argon2id;
    if (!fn) throw new Error("Argon2id is unavailable in this browser");
    const normalized = String(phrase ?? "").normalize("NFC").toLowerCase();
    if (!normalized) throw new Error("Passphrase is empty");
    const hash = await fn({
      password: normalized,
      salt: APP_SALT,
      parallelism: KDF.parallelism,
      iterations: KDF.iterations,
      memorySize: KDF.memorySize,
      hashLength: KDF.hashLength,
      outputType: "binary",
    });
    const key = hash instanceof Uint8Array ? hash : new Uint8Array(hash);
    self.postMessage({ id, ok: true, key: key.buffer }, [key.buffer]);
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : "KDF failed",
    });
  }
}

self.onmessage = (event) => {
  const data = event.data ?? {};
  jobChain = jobChain.then(() => runKdfJob(data));
};
