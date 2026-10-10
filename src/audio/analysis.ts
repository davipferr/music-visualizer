/**
 * Pure audio-analysis math: no Web Audio here, so all of it runs (and is tested) in Node.
 *
 * Input is what `AnalyserNode.getByteFrequencyData` returns: `fftSize / 2` magnitudes in 0–255,
 * already converted to dB and mapped from [minDecibels, maxDecibels]. Bin `i` is centred on
 * `i * sampleRate / fftSize` Hz, so bins are spaced *linearly*, but we hear pitch *logarithmically*:
 * one octave (A4 → A5, 440 → 880 Hz) spans 41 bins at 48 kHz / 4096, while the octave above it spans
 * 82 bins. Drawn linearly, the bass would be squeezed into the first few percent of the screen.
 */

// ---------------------------------------------------------------------------
// Log-frequency resampling
// ---------------------------------------------------------------------------

export interface LogBinOptions {
  sampleRate: number;
  /** AnalyserNode.fftSize (the spectrum has fftSize / 2 bins). */
  fftSize: number;
  fMin?: number;
  fMax?: number;
}

/** Edge frequencies of `count` log-spaced bands from fMin to fMax (count + 1 values). */
export function logEdges(count: number, fMin: number, fMax: number): Float64Array {
  const edges = new Float64Array(count + 1);
  const ratio = fMax / fMin;
  for (let i = 0; i <= count; i++) edges[i] = fMin * Math.pow(ratio, i / count);
  return edges;
}

/**
 * Resamples a linear spectrum onto `out.length` log-spaced bands, normalised to 0–1.
 *
 * A wide band (treble) takes the max of the FFT bins it covers, so one loud partial isn't
 * averaged away. A band narrower than one FFT bin (deep bass, where 30–40 Hz is less than a bin
 * wide) linearly interpolates the spectrum at the band's centre, so neighbouring bands vary
 * smoothly instead of repeating the same bin in steps.
 */
export function toLogBins(spectrum: ArrayLike<number>, out: Float32Array, opts: LogBinOptions): Float32Array {
  const { sampleRate, fftSize, fMin = 30, fMax = 16_000 } = opts;
  const hzPerBin = sampleRate / fftSize;
  const last = spectrum.length - 1;
  const edges = logEdges(out.length, fMin, fMax);

  for (let b = 0; b < out.length; b++) {
    const lo = edges[b] / hzPerBin;
    const hi = edges[b + 1] / hzPerBin;
    let v: number;
    if (Math.floor(hi) - Math.ceil(lo) >= 1) {
      v = 0;
      const end = Math.min(Math.floor(hi), last);
      for (let i = Math.ceil(lo); i <= end; i++) if (spectrum[i] > v) v = spectrum[i];
    } else {
      const c = Math.min(Math.sqrt(lo * hi), last); // geometric centre: the band's middle in pitch
      const i = Math.floor(c);
      const f = c - i;
      v = spectrum[i] * (1 - f) + spectrum[Math.min(i + 1, last)] * f;
    }
    out[b] = v / 255;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

export const BANDS = [
  { name: 'sub', lo: 20, hi: 60 },
  { name: 'bass', lo: 60, hi: 250 },
  { name: 'lowMid', lo: 250, hi: 500 },
  { name: 'mid', lo: 500, hi: 2_000 },
  { name: 'high', lo: 2_000, hi: 6_000 },
  { name: 'air', lo: 6_000, hi: 16_000 },
] as const;

export type BandName = (typeof BANDS)[number]['name'];
export type Bands = Record<BandName, number>;

/** Mean magnitude (0–1) of the FFT bins inside each band. */
export function bandEnergies(spectrum: ArrayLike<number>, sampleRate: number, fftSize: number): Bands {
  const hzPerBin = sampleRate / fftSize;
  const out = {} as Bands;
  for (const { name, lo, hi } of BANDS) {
    const a = Math.max(0, Math.ceil(lo / hzPerBin));
    const b = Math.min(spectrum.length - 1, Math.floor(hi / hzPerBin));
    let sum = 0;
    for (let i = a; i <= b; i++) sum += spectrum[i];
    out[name] = b >= a ? sum / (b - a + 1) / 255 : 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Envelope follower
// ---------------------------------------------------------------------------

/**
 * Attack/release smoothing, the same thing a compressor or VU meter does: rise fast so hits
 * register, fall slowly so the picture doesn't flicker. Time-constant based, so it behaves the
 * same at 30 fps and 144 fps (a fixed `lerp(x, target, 0.1)` per frame would not).
 */
export class Envelope {
  value = 0;
  constructor(
    public attack = 0.03,
    public release = 0.25,
  ) {}

  update(target: number, dt: number): number {
    const tau = target > this.value ? this.attack : this.release;
    this.value += (target - this.value) * (1 - Math.exp(-dt / tau));
    return this.value;
  }
}

// ---------------------------------------------------------------------------
// Auto-gain
// ---------------------------------------------------------------------------

/**
 * Normalises a level by a slowly decaying running peak, so a quiet acoustic track and a
 * brickwalled EDM master both fill the scene. The peak jumps up instantly and decays with a
 * half-life of `halfLife` seconds; `floor` stops silence from being amplified into noise.
 */
export class AutoGain {
  peak: number;
  constructor(
    public halfLife = 4,
    public floor = 0.15,
  ) {
    this.peak = floor;
  }

  apply(level: number, dt: number): number {
    this.peak = Math.max(level, this.floor, this.peak * Math.pow(0.5, dt / this.halfLife));
    return Math.min(1, level / this.peak);
  }

  reset(): void {
    this.peak = this.floor;
  }
}

// ---------------------------------------------------------------------------
// Beat detection
// ---------------------------------------------------------------------------

export interface Beat {
  /** Seconds, on the clock passed to `update`. */
  time: number;
  /** How far the onset cleared the threshold, ~1 = barely, 3+ = a big hit. */
  strength: number;
}

/**
 * Onset detection by *spectral flux*: sum how much each bass bin got louder since the last frame
 * (ignoring bins that got quieter). Sustained bass gives ~0 flux; a kick drum gives a spike. A
 * spike counts as a beat when it clears `mean + k·σ` of the last ~1.5 s of flux (an adaptive
 * threshold, so it works on any mix) and at least `minInterval` has passed since the last one.
 *
 * Feed it an *unsmoothed* spectrum (AnalyserNode smoothingTimeConstant = 0); smoothing blurs onsets.
 */
export class BeatDetector {
  private prev: Float32Array | null = null;
  private flux: number[] = [];
  private times: number[] = [];
  private startedAt = 0;
  lastBeat = -Infinity;

  constructor(
    public opts = { fMin: 30, fMax: 180, k: 1.6, window: 1.5, minInterval: 0.28, minFlux: 0.6 },
  ) {}

  /** Returns a Beat when `spectrum` (byte magnitudes) contains an onset, else null. */
  update(spectrum: ArrayLike<number>, sampleRate: number, fftSize: number, time: number): Beat | null {
    const hzPerBin = sampleRate / fftSize;
    const a = Math.max(1, Math.round(this.opts.fMin / hzPerBin));
    const b = Math.min(spectrum.length - 1, Math.round(this.opts.fMax / hzPerBin));
    const n = b - a + 1;
    if (!this.prev || this.prev.length !== n) {
      this.prev = new Float32Array(n);
      for (let i = 0; i < n; i++) this.prev[i] = spectrum[a + i];
      this.startedAt = time;
      return null;
    }

    let f = 0;
    for (let i = 0; i < n; i++) {
      const d = spectrum[a + i] - this.prev[i];
      if (d > 0) f += d;
      this.prev[i] = spectrum[a + i];
    }
    f /= n; // mean rise per bin, in byte units

    // Statistics of the window *before* this frame, so the spike doesn't raise its own bar.
    let mean = 0;
    for (const x of this.flux) mean += x;
    mean /= this.flux.length || 1;
    let varSum = 0;
    for (const x of this.flux) varSum += (x - mean) ** 2;
    const sd = Math.sqrt(varSum / (this.flux.length || 1));
    const threshold = Math.max(this.opts.minFlux, mean + this.opts.k * sd);

    this.flux.push(f);
    this.times.push(time);
    while (this.times.length && time - this.times[0] > this.opts.window) {
      this.flux.shift();
      this.times.shift();
    }

    // Wait for a third of a window of history: a near-empty window has a tiny σ, so any wobble
    // would clear it.
    const warm = time - this.startedAt >= this.opts.window / 3;
    if (!warm || f <= threshold || time - this.lastBeat < this.opts.minInterval) return null;
    this.lastBeat = time;
    return { time, strength: f / threshold };
  }

  reset(): void {
    this.prev = null;
    this.flux = [];
    this.times = [];
    this.lastBeat = -Infinity;
  }
}

// ---------------------------------------------------------------------------
// Tempo
// ---------------------------------------------------------------------------

/**
 * Tempo by *autocorrelation* of the onset signal, the textbook method. A beat detector's gaps
 * can't separate the beat from syncopation: in "Get Lucky" the bass plays off the beat, so the
 * onsets come at uneven intervals and the median gap is wrong. Autocorrelation asks instead
 * "at which delay does the rhythm best line up with itself?", which uses every onset (kicks,
 * snares, hats, bass) at once.
 *
 * 1. Onset strength: wide-band spectral flux (30 Hz–10 kHz), resampled onto a fixed 50 Hz grid so
 *    the result doesn't depend on the frame rate.
 * 2. r(L) = Σ x[i]·x[i+L] over the last 8 s, for lags covering 55–200 BPM.
 * 3. Weight r(L) by a prior centred on 120 BPM (log-scale Gaussian), which resolves octave
 *    ambiguity: a 116 BPM track also correlates at 58 and 232.
 * 4. Refine the peak with a parabola through its neighbours (sub-sample lag, so better than the
 *    grid's ~2 BPM steps), and report the median of recent estimates.
 */
export class TempoEstimator {
  static readonly RATE = 50;
  private readonly size: number;
  private readonly buf: Float32Array;
  private written = 0; // total slots pushed
  private slotStart = -1;
  private slotSum = 0;
  private prev: Float32Array | null = null;
  private lastEstimate = 0;
  private estimates: number[] = [];
  /**
   * Peak autocorrelation over r(0). Noise alone reaches ~0.1 at some lag over an 8 s window
   * (about 1/√400 per lag, maximised over ~40 lags), so a tempo is only reported above 0.15.
   */
  confidence = 0;

  constructor(
    readonly seconds = 8,
    readonly minBpm = 55,
    readonly maxBpm = 200,
  ) {
    this.size = Math.round(seconds * TempoEstimator.RATE);
    this.buf = new Float32Array(this.size);
  }

  /** Wide-band flux of one spectrum (mean positive rise per bin). */
  private flux(spectrum: ArrayLike<number>, sampleRate: number, fftSize: number): number {
    const hzPerBin = sampleRate / fftSize;
    const a = Math.max(1, Math.round(30 / hzPerBin));
    const b = Math.min(spectrum.length - 1, Math.round(10_000 / hzPerBin));
    const n = b - a + 1;
    if (!this.prev || this.prev.length !== n) {
      this.prev = new Float32Array(n);
      for (let i = 0; i < n; i++) this.prev[i] = spectrum[a + i];
      return 0;
    }
    let f = 0;
    for (let i = 0; i < n; i++) {
      const d = spectrum[a + i] - this.prev[i];
      if (d > 0) f += d;
      this.prev[i] = spectrum[a + i];
    }
    return f / n;
  }

  update(spectrum: ArrayLike<number>, sampleRate: number, fftSize: number, time: number): void {
    const f = this.flux(spectrum, sampleRate, fftSize);
    this.pushOnset(f, time);
  }

  /** Adds onset strength `f` at `time` (seconds). Exposed for tests. */
  pushOnset(f: number, time: number): void {
    const dt = 1 / TempoEstimator.RATE;
    if (this.slotStart < 0) this.slotStart = time;
    // Close every slot that ended before this sample; empty ones get 0.
    while (time >= this.slotStart + dt) {
      this.buf[this.written % this.size] = this.slotSum;
      this.written++;
      this.slotSum = 0;
      this.slotStart += dt;
      // A long gap (paused, hidden tab): restart rather than fill seconds of zeros.
      if (time - this.slotStart > 1) {
        this.reset();
        this.slotStart = time;
        break;
      }
    }
    this.slotSum += f;
    if (time - this.lastEstimate >= 0.5) {
      this.lastEstimate = time;
      this.estimate();
    }
  }

  private estimate(): void {
    const RATE = TempoEstimator.RATE;
    const n = Math.min(this.written, this.size);
    if (n < RATE * 5) return; // need 5 s of rhythm

    // Unroll the ring (oldest first) through a 5-tap triangle filter: onsets become small humps
    // rather than single-sample spikes, so the autocorrelation peaks are rounded enough for the
    // parabola fit to be accurate. Then remove the mean (a constant correlates with everything).
    const x = new Float32Array(n);
    const start = this.written - n;
    const at = (i: number) => this.buf[(start + Math.min(n - 1, Math.max(0, i))) % this.size];
    let mean = 0;
    for (let i = 0; i < n; i++) {
      mean += x[i] = (at(i - 2) + 2 * at(i - 1) + 3 * at(i) + 2 * at(i + 1) + at(i + 2)) / 9;
    }
    mean /= n;
    for (let i = 0; i < n; i++) x[i] -= mean;

    const r = (lag: number) => {
      let s = 0;
      for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag];
      return s / (n - lag);
    };
    const r0 = r(0);
    if (r0 <= 1e-9) return;

    const minLag = Math.floor((60 * RATE) / this.maxBpm);
    const maxLag = Math.ceil((60 * RATE) / this.minBpm);
    const rs = new Float64Array(maxLag + 2);
    for (let lag = minLag - 1; lag <= maxLag + 1; lag++) rs[lag] = r(lag);

    let best = -1;
    let bestScore = -Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
      // Only local maxima: a shoulder of a bigger peak isn't a tempo.
      if (rs[lag] < rs[lag - 1] || rs[lag] < rs[lag + 1]) continue;
      const bpm = (60 * RATE) / lag;
      const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
      const score = (rs[lag] / r0) * prior;
      if (score > bestScore) {
        bestScore = score;
        best = lag;
      }
    }
    if (best < 0) return;

    // Parabolic interpolation of the peak position.
    const [y0, y1, y2] = [rs[best - 1], rs[best], rs[best + 1]];
    const denom = y0 - 2 * y1 + y2;
    const lag = best + (denom < 0 ? (0.5 * (y0 - y2)) / denom : 0);

    this.confidence = rs[best] / r0;
    this.estimates.push((60 * RATE) / lag);
    if (this.estimates.length > 7) this.estimates.shift();
  }

  /** Current tempo in BPM, or null without a clear pulse yet. */
  bpm(): number | null {
    if (this.estimates.length < 3 || this.confidence < 0.15) return null;
    const sorted = [...this.estimates].sort((a, b) => a - b);
    return Math.round(sorted[sorted.length >> 1]);
  }

  reset(): void {
    this.buf.fill(0);
    this.written = 0;
    this.slotStart = -1;
    this.slotSum = 0;
    this.prev = null;
    this.lastEstimate = 0;
    this.estimates = [];
    this.confidence = 0;
  }
}
