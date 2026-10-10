/**
 * Extracts a scene palette from album art.
 *
 * k-means clustering in RGB on a downscaled cover finds its dominant colours; then roles are
 * assigned by what the scene needs, not by population: a dark `base` for the ground and fog, a
 * saturated `accent` for peaks and particles, and a `glow` for the hottest highlights. Covers
 * that are nearly grey (a lot of them) get their accent's saturation pushed up, or fall back to a
 * default, so the visuals never go muddy.
 */

export type RGB = [number, number, number]; // 0–1

export interface Palette {
  base: RGB;
  mid: RGB;
  accent: RGB;
  glow: RGB;
}

export const DEFAULT_PALETTE: Palette = {
  base: [0.03, 0.02, 0.08],
  mid: [0.28, 0.1, 0.55],
  accent: [1.0, 0.18, 0.55],
  glow: [0.35, 0.95, 1.0],
};

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

export function rgbToHsl([r, g, b]: RGB): RGB {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [((h * 60 + 360) % 360) / 360, s, l];
}

export function hslToRgb([h, s, l]: RGB): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h * 6;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b]: RGB =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}

/** Relative luminance (sRGB coefficients, applied directly; good enough for ranking). */
export const luminance = ([r, g, b]: RGB): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Chroma-ish "how colourful": HSL saturation weighted toward mid lightness. */
export function vividness(c: RGB): number {
  const [, s, l] = rgbToHsl(c);
  return s * (1 - Math.abs(2 * l - 1));
}

export const toHex = (c: RGB): string =>
  '#' + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');

// ---------------------------------------------------------------------------
// k-means
// ---------------------------------------------------------------------------

export interface Cluster {
  color: RGB;
  /** Share of sampled pixels, 0–1. */
  weight: number;
}

/**
 * k-means on RGBA bytes (alpha < 128 skipped). Seeded with k-means++ on a fixed-seed PRNG, so
 * the same cover always gives the same palette. Returns clusters sorted by weight, empty ones dropped.
 */
export function kmeans(rgba: ArrayLike<number>, k = 6, iterations = 12): Cluster[] {
  const pts: number[] = [];
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    pts.push(rgba[i] / 255, rgba[i + 1] / 255, rgba[i + 2] / 255);
  }
  const n = pts.length / 3;
  if (n === 0) return [];
  k = Math.min(k, n);

  let seed = 0x9e3779b9;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  const d2 = (i: number, c: number[], j: number) =>
    (pts[i * 3] - c[j * 3]) ** 2 + (pts[i * 3 + 1] - c[j * 3 + 1]) ** 2 + (pts[i * 3 + 2] - c[j * 3 + 2]) ** 2;

  // k-means++: each new centre is picked with probability ∝ squared distance to the nearest one.
  const centres: number[] = [];
  const first = Math.floor(rand() * n);
  centres.push(pts[first * 3], pts[first * 3 + 1], pts[first * 3 + 2]);
  const nearest = new Float64Array(n).fill(Infinity);
  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let i = 0; i < n; i++) {
      nearest[i] = Math.min(nearest[i], d2(i, centres, c - 1));
      total += nearest[i];
    }
    let r = rand() * total;
    let pick = n - 1;
    for (let i = 0; i < n; i++) {
      r -= nearest[i];
      if (r <= 0) {
        pick = i;
        break;
      }
    }
    centres.push(pts[pick * 3], pts[pick * 3 + 1], pts[pick * 3 + 2]);
  }

  const assign = new Int32Array(n);
  const sums = new Float64Array(k * 3);
  const counts = new Int32Array(k);
  for (let it = 0; it < iterations; it++) {
    sums.fill(0);
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let j = 0; j < k; j++) {
        const d = d2(i, centres, j);
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      }
      assign[i] = best;
      counts[best]++;
      sums[best * 3] += pts[i * 3];
      sums[best * 3 + 1] += pts[i * 3 + 1];
      sums[best * 3 + 2] += pts[i * 3 + 2];
    }
    for (let j = 0; j < k; j++) {
      if (!counts[j]) continue;
      centres[j * 3] = sums[j * 3] / counts[j];
      centres[j * 3 + 1] = sums[j * 3 + 1] / counts[j];
      centres[j * 3 + 2] = sums[j * 3 + 2] / counts[j];
    }
  }

  const out: Cluster[] = [];
  for (let j = 0; j < k; j++) {
    if (counts[j]) out.push({ color: [centres[j * 3], centres[j * 3 + 1], centres[j * 3 + 2]], weight: counts[j] / n });
  }
  return out.sort((a, b) => b.weight - a.weight);
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/** Signed shortest step from hue a to hue b (0–1 wheel), in [-0.5, 0.5). */
const hueDelta = (a: number, b: number): number => ((((b - a + 0.5) % 1) + 1) % 1) - 0.5;

/** Distance between hues round the wheel, 0–0.5. */
export const hueDistance = (a: number, b: number): number => Math.abs(hueDelta(a, b));

/** Interpolates hues the short way round the colour wheel: lerpHue(0.9, 0.1, 0.5) = 0. */
export function lerpHue(a: number, b: number, t: number): number {
  return (((a + hueDelta(a, b) * t) % 1) + 1) % 1;
}

/** Rotates hue and sets saturation/lightness: derives a colour that harmonises with `c`. */
function shift(c: RGB, dh: number, s: number, l: number): RGB {
  const [h] = rgbToHsl(c);
  return hslToRgb([(h + dh + 1) % 1, s, l]);
}

export function paletteFromClusters(clusters: Cluster[]): Palette {
  const usable = clusters.filter((c) => c.weight >= 0.02);
  if (!usable.length) return DEFAULT_PALETTE;

  // Accent: the most vivid colour that isn't a speck, favouring bigger clusters a little.
  const accentC = [...usable].sort(
    (a, b) => vividness(b.color) * (0.6 + b.weight) - vividness(a.color) * (0.6 + a.weight),
  )[0];
  const [ah, as] = rgbToHsl(accentC.color);
  if (as < 0.12) return DEFAULT_PALETTE; // a greyscale cover: nothing to build on

  // Normalise the accent to a bright, saturated version of its hue.
  const accent = hslToRgb([ah, Math.max(0.75, as), 0.58]);

  // Glow: the most vivid *other* cluster if its hue is far enough away, else a complementary-ish
  // shift of the accent (analogous colours read as one in bloom).
  const other = usable
    .filter((c) => c !== accentC && vividness(c.color) > 0.15)
    .map((c) => ({ c, dh: hueDistance(ah, rgbToHsl(c.color)[0]) }))
    .filter((o) => o.dh > 0.08)
    .sort((a, b) => vividness(b.c.color) - vividness(a.c.color))[0];
  const glow = other
    ? hslToRgb([rgbToHsl(other.c.color)[0], 0.85, 0.65])
    : shift(accent, 0.45, 0.85, 0.65);

  // Base and mid: the darkest colour's hue (usually the cover's background), kept very dark.
  const darkest = [...usable].sort((a, b) => luminance(a.color) - luminance(b.color))[0];
  const [dh, ds] = rgbToHsl(darkest.color);
  const baseHue = ds > 0.1 ? dh : ah;
  const base = hslToRgb([baseHue, Math.min(0.7, Math.max(0.35, ds)), 0.05]);
  const mid = hslToRgb([lerpHue(baseHue, ah, 0.5), 0.6, 0.28]);

  return { base, mid, accent, glow };
}

export function extractPalette(rgba: ArrayLike<number>): Palette {
  return paletteFromClusters(kmeans(rgba));
}

export function lerpPalette(a: Palette, b: Palette, t: number): Palette {
  const mix = (x: RGB, y: RGB): RGB => [x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t];
  return { base: mix(a.base, b.base), mid: mix(a.mid, b.mid), accent: mix(a.accent, b.accent), glow: mix(a.glow, b.glow) };
}

/** Browser-only: loads a CORS image and returns its pixels at 48×48 (plenty for clustering). */
export async function imagePixels(img: HTMLImageElement, size = 48): Promise<Uint8ClampedArray> {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, size, size);
  return g.getImageData(0, 0, size, size).data;
}
