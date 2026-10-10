import { describe, expect, it } from 'vitest';

import { AutoGain, BeatDetector, Envelope, TempoEstimator, bandEnergies, logEdges, toLogBins } from './audio/analysis';
import { artworkAt, defaultCountry, searchUrl, toTrack, type ItunesResult } from './data/itunes';
import {
  DEFAULT_PALETTE,
  extractPalette,
  hslToRgb,
  hueDistance,
  kmeans,
  lerpHue,
  rgbToHsl,
  vividness,
  type RGB,
} from './color/palette';
import { SpectrumHistory } from './scene/history';
import { AdaptiveResolution } from './scene/quality';

const SR = 48_000;
const FFT = 4096;
const hzPerBin = SR / FFT;

/** A byte spectrum with a single peak at `hz`. */
function tone(hz: number, level = 200, bins = FFT / 2): Uint8Array {
  const s = new Uint8Array(bins);
  s[Math.round(hz / hzPerBin)] = level;
  return s;
}

describe('log bins', () => {
  it('spaces edges geometrically', () => {
    const e = logEdges(10, 20, 20_480);
    expect(e[0]).toBeCloseTo(20);
    expect(e[10]).toBeCloseTo(20_480);
    // 10 bands over 10 octaves: one octave each
    for (let i = 1; i <= 10; i++) expect(e[i] / e[i - 1]).toBeCloseTo(2);
  });

  it('puts a tone in the band that covers its frequency', () => {
    const out = new Float32Array(64);
    toLogBins(tone(1_000), out, { sampleRate: SR, fftSize: FFT });
    const peak = out.indexOf(Math.max(...out));
    const e = logEdges(64, 30, 16_000);
    expect(e[peak]).toBeLessThanOrEqual(1_000 + hzPerBin);
    expect(e[peak + 1]).toBeGreaterThanOrEqual(1_000 - hzPerBin);
    expect(out[peak]).toBeCloseTo(200 / 255);
  });

  it('interpolates bands narrower than an FFT bin instead of stepping', () => {
    // A linear ramp: deep-bass bands (less than a bin wide) should still increase strictly.
    const ramp = Uint8Array.from({ length: FFT / 2 }, (_, i) => Math.min(255, i * 20));
    const out = new Float32Array(128);
    toLogBins(ramp, out, { sampleRate: SR, fftSize: FFT });
    for (let i = 1; i < 12; i++) expect(out[i]).toBeGreaterThan(out[i - 1]);
  });

  it('measures band energy', () => {
    const b = bandEnergies(tone(100, 255), SR, FFT);
    expect(b.bass).toBeGreaterThan(0);
    expect(b.mid).toBe(0);
    expect(b.air).toBe(0);
  });
});

describe('Envelope', () => {
  it('attacks fast and releases slowly', () => {
    const e = new Envelope(0.02, 0.5);
    e.update(1, 0.05);
    expect(e.value).toBeGreaterThan(0.9);
    e.update(0, 0.05);
    expect(e.value).toBeGreaterThan(0.8);
  });

  it('is frame-rate independent', () => {
    const a = new Envelope(0.1, 0.1);
    const b = new Envelope(0.1, 0.1);
    for (let i = 0; i < 30; i++) a.update(1, 1 / 30);
    for (let i = 0; i < 144; i++) b.update(1, 1 / 144);
    expect(a.value).toBeCloseTo(b.value, 6);
  });
});

describe('AutoGain', () => {
  it('normalises to the running peak and decays it', () => {
    const g = new AutoGain(1, 0.1);
    expect(g.apply(0.4, 0.016)).toBe(1);
    expect(g.apply(0.2, 0.016)).toBeCloseTo(0.5, 1);
    for (let i = 0; i < 60; i++) g.apply(0.2, 1 / 60); // one half-life
    expect(g.peak).toBeCloseTo(0.2, 1);
  });

  it('does not amplify silence past the floor', () => {
    const g = new AutoGain(1, 0.15);
    expect(g.apply(0.01, 1)).toBeCloseTo(0.01 / 0.15);
  });
});

describe('BeatDetector', () => {
  /** Simulates a kick every `period` s over a low noise bed, at 60 fps. */
  function run(period: number, seconds: number) {
    const det = new BeatDetector();
    const beats: number[] = [];
    let seed = 1;
    const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 20;
    for (let f = 0; f < seconds * 60; f++) {
      const t = f / 60;
      const sinceKick = t % period;
      const kick = sinceKick < 1 / 60 ? 230 : Math.max(0, 230 * Math.exp(-sinceKick / 0.08));
      const s = new Uint8Array(1024);
      for (let i = 0; i < s.length; i++) s[i] = 40 + noise();
      for (let i = 2; i < 8; i++) s[i] = Math.max(s[i], kick); // ~47–188 Hz at 48k/2048
      const b = det.update(s, SR, 2048, t);
      if (b) beats.push(b.time);
    }
    return { det, beats };
  }

  it('finds every kick at 120 BPM and no extras', () => {
    const { beats } = run(0.5, 10);
    // the first 0.5 s warms up the threshold window
    expect(beats.length).toBeGreaterThanOrEqual(18);
    expect(beats.length).toBeLessThanOrEqual(20);
    for (let i = 1; i < beats.length; i++) expect(beats[i] - beats[i - 1]).toBeCloseTo(0.5, 1);
  });

  it('ignores a steady tone', () => {
    const det = new BeatDetector();
    let n = 0;
    for (let f = 0; f < 300; f++) if (det.update(tone(100, 220, 1024), SR, 2048, f / 60)) n++;
    expect(n).toBe(0);
  });
});

describe('TempoEstimator', () => {
  /**
   * Feeds `seconds` of onsets at `fps`. `pattern` gives onset strengths at fractions of a beat,
   * e.g. [[0, 1], [0.75, 0.8]] = a kick on the beat plus a syncopated bass note.
   */
  function run(bpm: number, pattern: [number, number][], fps = 60, seconds = 12, noise = 0.05) {
    const est = new TempoEstimator();
    const beat = 60 / bpm;
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const frame = 1 / fps;
    for (let t = 0; t < seconds; t += frame) {
      let f = noise * rand();
      for (const [at, strength] of pattern) {
        // Is an onset at this fraction of a beat inside this frame?
        const phase = (((t / beat - at) % 1) + 1) % 1;
        if (phase * beat < frame) f += strength;
      }
      est.pushOnset(f, t);
    }
    return est;
  }

  it('finds a plain four-on-the-floor tempo', () => {
    expect(run(128, [[0, 1]]).bpm()).toBe(128);
  });

  it('is precise between grid steps (116 is between 50 Hz lags 25 and 26)', () => {
    expect(run(116, [[0, 1]]).bpm()).toBe(116);
  });

  it('is not fooled by syncopation (kick, snare, off-beat bass, eighth hats)', () => {
    const getLucky: [number, number][] = [
      [0, 1],
      [0.5, 0.3],
      [0.75, 0.7],
      [0.25, 0.25],
    ];
    expect(run(116, getLucky).bpm()).toBe(116);
  });

  it('works at 30 and 144 fps', () => {
    expect(run(100, [[0, 1], [0.5, 0.4]], 30).bpm()).toBe(100);
    expect(run(100, [[0, 1], [0.5, 0.4]], 144).bpm()).toBe(100);
  });

  it('prefers the beat over its octaves', () => {
    // Kick on 1 and 3 only, hats on every beat: still 120, not 60.
    expect(run(120, [[0, 1], [0.5, 0.15]]).bpm()).toBe(120);
  });

  it('reports nothing for noise', () => {
    expect(run(120, [], 60, 12, 1).bpm()).toBeNull();
  });
});

describe('iTunes', () => {
  const raw: ItunesResult = {
    wrapperType: 'track',
    kind: 'song',
    trackId: 697195787,
    trackName: 'One More Time',
    artistName: 'Daft Punk',
    collectionName: 'Discovery',
    artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/Music/v4/ab/cd/source/100x100bb.jpg',
    previewUrl: 'https://audio-ssl.itunes.apple.com/x.m4a',
    trackTimeMillis: 320_357,
    primaryGenreName: 'Dance',
    releaseDate: '2001-03-07T08:00:00Z',
  };

  it('maps results and upsizes artwork', () => {
    const t = toTrack(raw)!;
    expect(t.title).toBe('One More Time');
    expect(t.year).toBe(2001);
    expect(t.artwork).toMatch(/\/600x600bb\.jpg$/);
    expect(t.thumb).toMatch(/\/120x120bb\.jpg$/);
    expect(artworkAt('https://x/a/60x60bb.png', 300)).toBe('https://x/a/300x300bb.jpg');
  });

  it('skips results without a preview or that are not songs', () => {
    expect(toTrack({ ...raw, previewUrl: undefined })).toBeNull();
    expect(toTrack({ ...raw, kind: 'music-video' })).toBeNull();
    expect(toTrack({ ...raw, wrapperType: 'collection' })).toBeNull();
  });

  it('builds search URLs and picks a store front', () => {
    expect(searchUrl(' tom jobim ', 'BR')).toBe(
      'https://itunes.apple.com/search?term=tom+jobim&media=music&entity=song&limit=30&country=BR',
    );
    expect(defaultCountry('pt-BR')).toBe('BR');
    expect(defaultCountry('en')).toBe('US');
  });
});

describe('palette', () => {
  const close = (a: RGB, b: RGB, digits = 5) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));

  it('round-trips HSL', () => {
    for (const c of [[1, 0, 0], [0.2, 0.6, 0.9], [0.5, 0.5, 0.5], [0.9, 0.8, 0.1]] as RGB[]) close(hslToRgb(rgbToHsl(c)), c);
  });

  it('interpolates hue the short way round', () => {
    expect(lerpHue(0.9, 0.1, 0.5)).toBeCloseTo(0);
    expect(lerpHue(0.1, 0.9, 0.5)).toBeCloseTo(0);
    expect(lerpHue(0.2, 0.4, 0.5)).toBeCloseTo(0.3);
    expect(hueDistance(0.95, 0.05)).toBeCloseTo(0.1);
    expect(hueDistance(0, 0.5)).toBeCloseTo(0.5);
  });

  /** RGBA pixels: `share` of each colour. */
  function image(colours: [RGB, number][]): Uint8ClampedArray {
    const px: number[] = [];
    for (const [c, share] of colours) {
      for (let i = 0; i < Math.round(share * 2000); i++) px.push(c[0] * 255, c[1] * 255, c[2] * 255, 255);
    }
    return Uint8ClampedArray.from(px);
  }

  it('finds the dominant colours', () => {
    const cl = kmeans(image([[[0.05, 0.05, 0.1], 0.6], [[0.9, 0.1, 0.2], 0.3], [[0.2, 0.8, 0.9], 0.1]]), 3);
    expect(cl).toHaveLength(3);
    expect(cl[0].weight).toBeCloseTo(0.6, 2);
    close(cl[1].color, [0.9, 0.1, 0.2], 2); // byte-quantised
  });

  it('takes the accent from the vivid colour, not the biggest one', () => {
    const p = extractPalette(image([[[0.08, 0.06, 0.05], 0.85], [[0.1, 0.3, 0.95], 0.15]]));
    expect(rgbToHsl(p.accent)[0]).toBeCloseTo(rgbToHsl([0.1, 0.3, 0.95])[0], 1);
    expect(vividness(p.accent)).toBeGreaterThan(0.5);
    expect(rgbToHsl(p.base)[2]).toBeLessThan(0.1);
  });

  it('falls back for greyscale covers', () => {
    expect(extractPalette(image([[[0.1, 0.1, 0.1], 0.5], [[0.9, 0.9, 0.9], 0.5]]))).toEqual(DEFAULT_PALETTE);
  });
});

describe('SpectrumHistory', () => {
  it('writes rows into a ring and reports the newest', () => {
    const h = new SpectrumHistory(4, 3);
    h.push(Float32Array.from([1, 0, 0, 0]));
    h.push(Float32Array.from([0, 1, 0, 0]));
    expect(h.head).toBe(2);
    expect([...h.data.slice(4, 8)]).toEqual([0, 255, 0, 0]);
    h.push(Float32Array.from([0, 0, 1, 0]));
    h.push(Float32Array.from([0, 0, 0, 1])); // wraps onto row 0
    expect(h.head).toBe(1);
    expect([...h.data.slice(0, 4)]).toEqual([0, 0, 0, 255]);
  });
});

describe('AdaptiveResolution', () => {
  /** Runs `seconds` of frames at `fps`, returning every ratio change. */
  function run(q: AdaptiveResolution, fps: (ratio: number) => number, seconds: number): number[] {
    const changes: number[] = [];
    for (let t = 0; t < seconds; ) {
      const dt = 1 / fps(q.ratio);
      t += dt;
      const r = q.update(dt);
      if (r !== null) changes.push(r);
    }
    return changes;
  }

  it('drops the ratio when frames are slow, then settles without oscillating', () => {
    const q = new AdaptiveResolution(2, 0.6, 1.5);
    // A GPU that holds 60 fps up to ratio 1.2 and halves to 30 above it.
    const gpu = (r: number) => (r > 1.2 ? 30 : 60);
    run(q, gpu, 120);
    expect(q.ratio).toBeLessThanOrEqual(1.2);
    expect(q.ratio).toBeGreaterThan(1); // backed off, not collapsed
    // Settled: failed ratios became ceilings, so it doesn't keep probing into stutter.
    expect(run(q, gpu, 300)).toEqual([]);
  });

  it('raises the ratio when there is headroom, up to max', () => {
    const q = new AdaptiveResolution(1.5, 0.6, 1);
    run(q, () => 60, 60);
    expect(q.ratio).toBe(1.5);
  });

  it('undoes a drop that does not help (frame rate capped elsewhere)', () => {
    const q = new AdaptiveResolution(2, 0.6, 1.25);
    // 30 fps whatever the ratio: a capped webview, or a CPU-bound frame.
    const changes = run(q, () => 30, 120);
    expect(q.ratio).toBe(1.25);
    expect(changes).toEqual([1.06, 0.9, 1.25]);
  });

  it('ignores windows with a long frame (hidden tab)', () => {
    const q = new AdaptiveResolution(2, 0.6, 1.25);
    expect(q.update(3)).toBeNull();
    for (let i = 0; i < 10; i++) expect(q.update(1 / 60)).toBeNull();
    expect(q.ratio).toBe(1.25);
  });
});
