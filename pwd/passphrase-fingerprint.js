const POINTS = 12;
const RAW_BUCKETS = 36;
const BAND_COUNT = 5;
/** Inward bands 0–1, neutral 2, outward bands 3–4. */
const NEUTRAL_BAND = 2;
const NEUTRAL = 18;
/** Legacy radii samples: same min/neutral/max spread as the old 0..35 scale. */
const BAND_LEGACY = [0, 12, 18, 24, 35];

/** Map a raw 0..35 draw into one of five bands. */
export function rawIndexToBand(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return NEUTRAL_BAND;
  const clamped = Math.min(RAW_BUCKETS - 1, Math.max(0, Math.floor(n)));
  return Math.min(BAND_COUNT - 1, Math.floor((clamped * BAND_COUNT) / RAW_BUCKETS));
}

export function bandToLegacyValue(band) {
  const b = Math.min(BAND_COUNT - 1, Math.max(0, Math.floor(band)));
  return BAND_LEGACY[b];
}

/** Deterministic 12 band indices in 0..4 from the passphrase (not cryptographic). */
export function passphraseFingerprintBands(passphrase) {
  const text = String(passphrase ?? "").normalize("NFC").toLowerCase();
  if (!text) return Array(POINTS).fill(NEUTRAL_BAND);

  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  const bands = [];
  for (let i = 0; i < POINTS; i += 1) {
    h = Math.imul(h ^ Math.imul(i + 1, 2654435761), 2246822519);
    h ^= h >>> 16;
    bands.push(rawIndexToBand((h >>> 0) % RAW_BUCKETS));
  }
  return bands;
}

/** Values passed to the path renderer (discrete legacy radii, not 0..35). */
export function passphraseFingerprintValues(passphrase) {
  return passphraseFingerprintBands(passphrase).map(bandToLegacyValue);
}

/** 12-char band fingerprint (0–4, for debugging). */
export function passphraseFingerprintHash(passphrase) {
  return passphraseFingerprintBands(passphrase).map(String).join("");
}

function radiusFactor(value) {
  if (value === NEUTRAL) return 1;
  if (value < NEUTRAL) {
    return 1 - (NEUTRAL - value) / NEUTRAL * 0.5;
  }
  return 1 + (value - NEUTRAL) / (35 - NEUTRAL) * 0.5;
}

function polarPoint(cx, cy, angle, radius) {
  return {
    x: cx + radius * Math.cos(angle),
    y: cy + radius * Math.sin(angle),
  };
}

function smoothClosedPath(pts) {
  const n = pts.length;
  if (n < 3) return "";
  let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
  for (let i = 0; i < n; i += 1) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return `${d} Z`;
}

export function fingerprintPathFromValues(values, { size = 50, neutralRadius = 10 } = {}) {
  const cx = size / 2;
  const cy = size / 2;
  const pts = [];
  for (let i = 0; i < POINTS; i += 1) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / POINTS;
    const v = values[i] ?? NEUTRAL;
    const r = neutralRadius * radiusFactor(v);
    pts.push(polarPoint(cx, cy, angle, r));
  }
  return smoothClosedPath(pts);
}

const MOTION_MS = 380;

function easeOutCubic(t) {
  const x = Math.min(1, Math.max(0, t));
  return 1 - (1 - x) ** 3;
}

export function mountPassphraseFingerprint(svgRoot) {
  const pathEl = svgRoot.querySelector("path");
  if (!pathEl) throw new Error("fingerprint svg needs a path");

  let displayed = Array(POINTS).fill(NEUTRAL);
  let target = Array(POINTS).fill(NEUTRAL);
  let animFrom = displayed.slice();
  let animStart = 0;
  let frame = 0;

  const draw = () => {
    pathEl.setAttribute("d", fingerprintPathFromValues(displayed));
  };

  const tick = (now) => {
    const t = easeOutCubic((now - animStart) / MOTION_MS);
    for (let i = 0; i < POINTS; i += 1) {
      displayed[i] = animFrom[i] + (target[i] - animFrom[i]) * t;
    }
    draw();
    if (now - animStart < MOTION_MS) {
      frame = requestAnimationFrame(tick);
    } else {
      displayed = target.slice();
      draw();
      frame = 0;
    }
  };

  const update = (passphrase) => {
    target = passphraseFingerprintValues(passphrase);
    animFrom = displayed.slice();
    animStart = performance.now();
    if (!frame) frame = requestAnimationFrame(tick);
  };

  draw();
  return { update };
}
