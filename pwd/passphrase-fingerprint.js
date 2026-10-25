const NEUTRAL = 18;
const POINTS = 12;
const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Deterministic 12 values in 0..35 from the passphrase (not cryptographic). */
export function passphraseFingerprintValues(passphrase) {
  const text = String(passphrase ?? "").normalize("NFC");
  if (!text) return Array(POINTS).fill(NEUTRAL);

  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  const values = [];
  for (let i = 0; i < POINTS; i += 1) {
    h = Math.imul(h ^ Math.imul(i + 1, 2654435761), 2246822519);
    h ^= h >>> 16;
    values.push((h >>> 0) % 36);
  }
  return values;
}

/** 12-char alphanumeric fingerprint (for debugging / display if needed). */
export function passphraseFingerprintHash(passphrase) {
  return passphraseFingerprintValues(passphrase)
    .map((v) => CHARSET[v])
    .join("");
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

export function mountPassphraseFingerprint(svgRoot) {
  const pathEl = svgRoot.querySelector("path");
  if (!pathEl) throw new Error("fingerprint svg needs a path");

  let displayed = Array(POINTS).fill(NEUTRAL);
  let target = Array(POINTS).fill(NEUTRAL);
  let frame = 0;

  const draw = () => {
    pathEl.setAttribute("d", fingerprintPathFromValues(displayed));
  };

  const tick = () => {
    let settled = true;
    for (let i = 0; i < POINTS; i += 1) {
      const diff = target[i] - displayed[i];
      if (Math.abs(diff) < 0.08) {
        displayed[i] = target[i];
      } else {
        displayed[i] += diff * 0.28;
        settled = false;
      }
    }
    draw();
    if (!settled) {
      frame = requestAnimationFrame(tick);
    } else {
      frame = 0;
    }
  };

  const update = (passphrase) => {
    target = passphraseFingerprintValues(passphrase);
    if (!frame) frame = requestAnimationFrame(tick);
  };

  draw();
  return { update };
}
