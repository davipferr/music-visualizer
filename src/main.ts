import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import {
  AutoGain,
  BeatDetector,
  Envelope,
  TempoEstimator,
  BANDS as BAND_DEFS,
  bandEnergies,
  toLogBins,
  type BandName,
} from './audio/analysis';
import { AudioEngine } from './audio/engine';
import { DEFAULT_PALETTE, extractPalette, imagePixels, lerpPalette, toHex, type Palette } from './color/palette';
import { defaultCountry, lookup, type Track } from './data/itunes';
import { Cover } from './scene/cover';
import { Particles } from './scene/particles';
import { Post } from './scene/post';
import { AdaptiveResolution } from './scene/quality';
import { BANDS, Terrain } from './scene/terrain';
import { SearchPanel } from './ui/search';
import { bindSettings, loadSettings, saveSettings } from './ui/settings';
import { createToast } from './ui/toast';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

const canvas = $<HTMLCanvasElement>('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
// Bloom, trails and the lens pass are fill-rate bound, so the pixel ratio adapts to the GPU.
const quality = new AdaptiveResolution(Math.min(window.devicePixelRatio, 2));
const pixelRatio = () => quality.ratio;
renderer.setPixelRatio(pixelRatio());
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
scene.background = new THREE.Color();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.5, 900);

const TARGET = new THREE.Vector3(0, 14, -80);
const HOME = new THREE.Vector3(0, 20, 64);
camera.position.copy(HOME);

const controls = new OrbitControls(camera, canvas);
controls.target.copy(TARGET);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 40;
controls.maxDistance = 260;
controls.maxPolarAngle = Math.PI / 2 - 0.02;
controls.enablePan = false;
controls.update();

const terrain = new Terrain();
const cover = new Cover();
const particles = new Particles();
scene.add(terrain.mesh, cover.group, particles.points);

const post = new Post(renderer, scene, camera);
post.setSize(window.innerWidth, window.innerHeight, pixelRatio());

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const settings = loadSettings();
const engine = new AudioEngine();
engine.setVolume(settings.volume);
const toast = createToast($('toast'));

let queue: Track[] = [];
let index = -1;
let current: Track | null = null;
let label = { title: 'Nothing playing', artist: 'Search for a song, or try one of the suggestions' };

const search = new SearchPanel(
  {
    form: $<HTMLFormElement>('search-form'),
    input: $<HTMLInputElement>('search'),
    country: $<HTMLSelectElement>('country'),
    chips: $('chips'),
    status: $('search-status'),
    list: $<HTMLUListElement>('results'),
  },
  new URLSearchParams(location.hash.slice(1)).get('country') ?? defaultCountry(),
  (results, i) => {
    queue = results.slice();
    void playIndex(i);
  },
);

// ---------------------------------------------------------------------------
// Palette (eased between tracks)
// ---------------------------------------------------------------------------

let paletteFrom: Palette = DEFAULT_PALETTE;
let paletteTo: Palette = DEFAULT_PALETTE;
let paletteT = 1;

function applyPalette(p: Palette): void {
  terrain.setPalette(p);
  cover.setPalette(p);
  particles.setPalette(p);
  (scene.background as THREE.Color).setRGB(p.base[0] * 0.6, p.base[1] * 0.6, p.base[2] * 0.6, THREE.SRGBColorSpace);
}

function setPalette(p: Palette): void {
  paletteFrom = lerpPalette(paletteFrom, paletteTo, paletteT);
  paletteTo = p;
  paletteT = 0;
  const root = document.documentElement.style;
  root.setProperty('--accent', toHex(p.accent));
  root.setProperty('--glow', toHex(p.glow));
  $('swatches').replaceChildren(
    ...[p.base, p.mid, p.accent, p.glow].map((c) => {
      const i = document.createElement('i');
      i.style.background = toHex(c);
      return i;
    }),
  );
}
applyPalette(DEFAULT_PALETTE);
setPalette(DEFAULT_PALETTE);

async function showArtwork(url: string | null): Promise<void> {
  try {
    const img = await cover.setArtwork(url);
    setPalette(img ? extractPalette(await imagePixels(img)) : DEFAULT_PALETTE);
  } catch {
    setPalette(DEFAULT_PALETTE);
  }
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

function resetAnalysis(): void {
  beats.reset();
  tempo.reset();
  bpmBadge.textContent = '— BPM';
  for (const g of Object.values(gains)) g.reset();
  energyGain.reset();
}

/** Sets the now-playing card, the URL and the OS media controls for a track. */
function showTrack(t: Track): void {
  current = t;
  label = { title: t.title, artist: [t.artist, t.album].filter(Boolean).join(' · ') };
  const art = $<HTMLImageElement>('np-art');
  art.src = t.thumb;
  art.hidden = false;
  const link = $<HTMLAnchorElement>('itunes-link');
  link.href = t.url;
  link.hidden = !t.url;
  search.setCurrent(t.id);
  history.replaceState(null, '', `#track=${t.id}&country=${search.country}`);
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist,
      album: t.album,
      artwork: [{ src: t.artwork, sizes: '600x600', type: 'image/jpeg' }],
    });
  }
  updateLabels();
  void showArtwork(t.artwork);
}

async function playTrack(t: Track): Promise<void> {
  $('start').hidden = true;
  showTrack(t);
  resetAnalysis();
  try {
    await engine.playUrl(t.preview, 'track');
  } catch (err) {
    if ((err as Error).name === 'AbortError') return; // superseded by another track
    toast(`Couldn't play this preview: ${(err as Error).message}`, 'error');
  }
  updateTransport();
}

async function playIndex(i: number): Promise<void> {
  if (i < 0 || i >= queue.length) return;
  index = i;
  await playTrack(queue[i]);
}

function step(delta: number): void {
  if (!queue.length) return;
  void playIndex((index + delta + queue.length) % queue.length);
}

async function playFile(file: File): Promise<void> {
  if (!file.type.startsWith('audio/') && !/\.(mp3|m4a|aac|wav|ogg|oga|flac|opus|webm)$/i.test(file.name)) {
    toast(`“${file.name}” doesn't look like an audio file.`, 'error');
    return;
  }
  $('start').hidden = true;
  current = null;
  index = -1;
  label = { title: file.name.replace(/\.[^.]+$/, ''), artist: 'Local file' };
  $('np-art').hidden = true;
  $('itunes-link').hidden = true;
  search.setCurrent(null);
  history.replaceState(null, '', location.pathname + location.search);
  resetAnalysis();
  void showArtwork(null);
  try {
    await engine.playFile(file);
  } catch (err) {
    toast(`Couldn't play “${file.name}”: ${(err as Error).message}`, 'error');
  }
  updateLabels();
  updateTransport();
}

async function toggleMic(): Promise<void> {
  if (engine.kind === 'mic') {
    engine.stopMic();
    label = { title: 'Nothing playing', artist: 'Microphone off' };
  } else {
    try {
      await engine.startMic();
      current = null;
      label = { title: 'Microphone', artist: 'Play something near your computer' };
      $('np-art').hidden = true;
      $('itunes-link').hidden = true;
      search.setCurrent(null);
      resetAnalysis();
      void showArtwork(null);
    } catch (err) {
      toast(`Microphone unavailable: ${(err as Error).message}`, 'error');
    }
  }
  updateLabels();
  updateTransport();
}

async function togglePlay(): Promise<void> {
  if (engine.kind === 'none') {
    if (current) return playTrack(current);
    if (queue.length) return playIndex(0);
    $<HTMLInputElement>('search').focus();
    return;
  }
  const wasMic = engine.kind === 'mic'; // toggling the mic turns it off
  try {
    await engine.toggle();
  } catch (err) {
    toast(`Playback failed: ${(err as Error).message}`, 'error');
  }
  if (wasMic) label = { title: 'Nothing playing', artist: 'Microphone off' };
  updateLabels();
  updateTransport();
}

// ---------------------------------------------------------------------------
// Player UI
// ---------------------------------------------------------------------------

const fmt = (s: number) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00');
const seek = $<HTMLInputElement>('seek');
let seeking = false;

function updateLabels(): void {
  $('np-title').textContent = label.title;
  $('np-artist').textContent = label.artist;
  document.title = current || engine.kind === 'file' ? `${label.title} · Music Visualizer` : 'Music Visualizer';
}

function updateTransport(): void {
  const playing = engine.playing;
  const play = $('play');
  play.textContent = playing ? '❚❚' : '▶';
  play.setAttribute('aria-label', playing ? 'Pause (Space)' : 'Play (Space)');
  $('prev').toggleAttribute('disabled', queue.length < 2);
  $('next').toggleAttribute('disabled', queue.length < 2);
  $('mic').classList.toggle('on', engine.kind === 'mic');
  seek.disabled = engine.kind === 'mic' || engine.kind === 'none';
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}

function updateProgress(): void {
  const el = engine.element;
  const dur = Number.isFinite(el.duration) ? el.duration : 30;
  seek.max = String(dur);
  if (!seeking) seek.value = String(el.currentTime);
  $('time').textContent = fmt(el.currentTime);
  $('duration').textContent = fmt(dur);
}

seek.addEventListener('input', () => {
  seeking = true;
  $('time').textContent = fmt(Number(seek.value));
});
seek.addEventListener('change', () => {
  engine.element.currentTime = Number(seek.value);
  seeking = false;
});

const el = engine.element;
for (const ev of ['play', 'pause', 'playing']) el.addEventListener(ev, updateTransport);
el.addEventListener('timeupdate', updateProgress);
el.addEventListener('loadedmetadata', updateProgress);
el.addEventListener('ended', () => {
  updateTransport();
  if (engine.kind === 'track' && settings.autoNext && queue.length > 1) step(1);
});
el.addEventListener('error', () => {
  if (engine.kind === 'track') toast('This preview failed to load. Try another result.', 'error');
});

$('play').addEventListener('click', () => void togglePlay());
$('prev').addEventListener('click', () => step(-1));
$('next').addEventListener('click', () => step(1));
$('mic').addEventListener('click', () => void toggleMic());

const volume = $<HTMLInputElement>('volume');
volume.value = String(settings.volume);
volume.addEventListener('input', () => {
  settings.volume = Number(volume.value);
  engine.setVolume(settings.volume);
  saveSettings(settings);
});

const fileInput = $<HTMLInputElement>('file');
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) void playFile(f);
  fileInput.value = '';
});

// Drag and drop anywhere. dragenter/leave fire for every child element, so count them.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  $('drop').hidden = false;
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('drop').hidden = true;
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').hidden = true;
  const f = e.dataTransfer?.files[0];
  if (f) void playFile(f);
});

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => void togglePlay());
  ms.setActionHandler('pause', () => void togglePlay());
  ms.setActionHandler('previoustrack', () => step(-1));
  ms.setActionHandler('nexttrack', () => step(1));
}

// ---------------------------------------------------------------------------
// Panels, settings, keyboard
// ---------------------------------------------------------------------------

$('collapse').addEventListener('click', () => {
  const collapsed = $('search-panel').classList.toggle('collapsed');
  $('collapse').textContent = collapsed ? '+' : '–';
});
$('settings-toggle').addEventListener('click', () => ($('settings').hidden = !$('settings').hidden));

function toggleUi(): void {
  document.body.classList.toggle('ui-hidden');
}
function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => {});
}
$('hide-ui').addEventListener('click', toggleUi);
$('fullscreen').addEventListener('click', toggleFullscreen);
// Any click on the empty scene brings a hidden UI back (it's otherwise invisible to touch users).
canvas.addEventListener('dblclick', () => document.body.classList.remove('ui-hidden'));

const syncSettings = bindSettings($('settings'), settings, applySettings);
function applySettings(): void {
  post.set(settings);
  particles.points.visible = settings.particles;
}
applySettings();

// Dragging the camera hands it to the user; C gives it back to the autopilot.
controls.addEventListener('start', () => {
  if (!settings.autoCamera) return;
  settings.autoCamera = false;
  saveSettings(settings);
  syncSettings();
});

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t.matches('input[type="search"], input[type="text"], select') || e.ctrlKey || e.metaKey || e.altKey) {
    if (e.key === 'Escape') t.blur();
    return;
  }
  const el = engine.element;
  switch (e.key) {
    case ' ':
      e.preventDefault();
      // A focused button would also "click" on Space.
      (document.activeElement as HTMLElement | null)?.blur();
      void togglePlay();
      break;
    case 'ArrowRight':
      if (engine.kind === 'track' || engine.kind === 'file') el.currentTime = Math.min(el.duration || 0, el.currentTime + 5);
      break;
    case 'ArrowLeft':
      if (engine.kind === 'track' || engine.kind === 'file') el.currentTime = Math.max(0, el.currentTime - 5);
      break;
    case 'n':
    case 'N':
      step(1);
      break;
    case 'p':
    case 'P':
      step(-1);
      break;
    case 'h':
    case 'H':
      toggleUi();
      break;
    case 'f':
    case 'F':
      toggleFullscreen();
      break;
    case 'm':
    case 'M':
      void toggleMic();
      break;
    case 'c':
    case 'C':
      settings.autoCamera = !settings.autoCamera;
      saveSettings(settings);
      syncSettings();
      toast(settings.autoCamera ? 'Auto camera on' : 'Auto camera off');
      break;
    case '/':
      e.preventDefault();
      document.body.classList.remove('ui-hidden');
      $('search-panel').classList.remove('collapsed');
      $<HTMLInputElement>('search').focus();
      break;
    case 'Escape':
      $('settings').hidden = true;
      break;
  }
});

// Band meters in the settings panel.
const meters = BAND_DEFS.map(({ name }) => {
  const d = document.createElement('div');
  const i = document.createElement('i');
  const s = document.createElement('span');
  s.textContent = name === 'lowMid' ? 'lo-mid' : name;
  d.append(i, s);
  $('meters').append(d);
  return i;
});

// ---------------------------------------------------------------------------
// Analysis state
// ---------------------------------------------------------------------------

const logBands = new Float32Array(BANDS);
const beats = new BeatDetector();
const tempo = new TempoEstimator();
const gains = Object.fromEntries(BAND_DEFS.map(({ name }) => [name, new AutoGain(5, 0.12)])) as Record<BandName, AutoGain>;
const envs = Object.fromEntries(BAND_DEFS.map(({ name }) => [name, new Envelope(0.025, 0.22)])) as Record<BandName, Envelope>;
const energyGain = new AutoGain(6, 0.15);
const energyEnv = new Envelope(0.2, 0.8);
let beatPulse = 0;
let idle = 1;
let historyClock = 0;
const HISTORY_HZ = 60; // rows per second: the landscape scrolls at the same speed at any frame rate

const bpmBadge = $('bpm');
let bpmFlash = 0;

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

const shake = new THREE.Vector3();
const spherical = new THREE.Spherical().setFromVector3(HOME.clone().sub(TARGET));
const homeSpherical = spherical.clone();

function autopilot(time: number, dt: number): void {
  // Ease back toward the home framing, then sway slowly around it.
  const goal = new THREE.Spherical(
    homeSpherical.radius + Math.sin(time * 0.05) * 14,
    homeSpherical.phi + Math.sin(time * 0.071) * 0.07,
    homeSpherical.theta + Math.sin(time * 0.043) * 0.33,
  );
  spherical.setFromVector3(camera.position.clone().sub(controls.target));
  const k = 1 - Math.exp(-dt * 0.8);
  spherical.radius += (goal.radius - spherical.radius) * k;
  spherical.phi += (goal.phi - spherical.phi) * k;
  spherical.theta += (goal.theta - spherical.theta) * k;
  controls.target.lerp(TARGET, k);
  camera.position.setFromSpherical(spherical).add(controls.target);
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

const clock = new THREE.Clock();
const SILENCE = new Uint8Array(0);

function resize(): void {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(pixelRatio());
  renderer.setSize(window.innerWidth, window.innerHeight);
  post.setSize(window.innerWidth, window.innerHeight, pixelRatio());
}

function frame(): void {
  const rawDt = clock.getDelta();
  if (quality.update(rawDt) !== null) resize();
  const dt = Math.min(rawDt, 0.1);
  const time = clock.elapsedTime;
  const active = engine.sample() && engine.playing;

  let bass = 0;
  let mids = 0;
  let high = 0;

  if (active) {
    const sr = engine.sampleRate;
    toLogBins(engine.spectrum, logBands, { sampleRate: sr, fftSize: engine.display.fftSize });
    // Expand contrast: dB-mapped bytes sit high for most of the spectrum, so a power curve keeps
    // the valleys low and lets real peaks stand out.
    const sens = settings.sensitivity;
    for (let i = 0; i < BANDS; i++) logBands[i] = Math.min(1.2, Math.pow(logBands[i], 1.6) * 1.15 * sens);
    historyClock += dt;
    while (historyClock >= 1 / HISTORY_HZ) {
      terrain.push(logBands);
      historyClock -= 1 / HISTORY_HZ;
    }

    const raw = bandEnergies(engine.spectrum, sr, engine.display.fftSize);
    BAND_DEFS.forEach(({ name }, i) => {
      const v = envs[name].update(Math.min(1, gains[name].apply(raw[name], dt) * sens), dt);
      meters[i].style.setProperty('--v', v.toFixed(3));
    });
    bass = Math.max(envs.sub.value, envs.bass.value);
    mids = (envs.lowMid.value + envs.mid.value) / 2;
    high = (envs.high.value + envs.air.value) / 2;

    const mean = (raw.sub + raw.bass + raw.lowMid + raw.mid + raw.high) / 5;
    energyEnv.update(energyGain.apply(mean, dt), dt);

    const now = engine.ctx!.currentTime;
    tempo.update(engine.onsetSpectrum, sr, engine.onset.fftSize, now);
    const beat = beats.update(engine.onsetSpectrum, sr, engine.onset.fftSize, now);
    if (beat) {
      beatPulse = Math.min(1, 0.55 + 0.2 * beat.strength);
      particles.beat(beat.strength);
      bpmFlash = 0.09;
      const bpm = tempo.bpm();
      bpmBadge.textContent = bpm ? `${bpm} BPM` : '— BPM';
    }
  } else {
    for (const i of meters) i.style.setProperty('--v', '0');
    energyEnv.update(0, dt);
  }

  beatPulse *= Math.exp(-dt / 0.16);
  idle += ((active ? 0 : 1) - idle) * (1 - Math.exp(-dt / 0.6));
  bpmFlash -= dt;
  bpmBadge.classList.toggle('pulse', bpmFlash > 0);

  if (paletteT < 1) {
    paletteT = Math.min(1, paletteT + dt / 1.4);
    const e = paletteT * paletteT * (3 - 2 * paletteT);
    applyPalette(lerpPalette(paletteFrom, paletteTo, e));
  }

  const energy = energyEnv.value;
  const tu = terrain.uniforms;
  tu.uTime.value = time;
  tu.uIdle.value = idle;
  tu.uBeat.value = beatPulse;
  cover.update(time, active ? engine.waveform : SILENCE, bass, beatPulse, mids);
  particles.update(time, dt, energy, high, renderer.getPixelRatio());
  post.update(time, bass, beatPulse, energy);

  if (settings.autoCamera) autopilot(time, dt);
  controls.update();

  // Shake is added for this frame only, so it never accumulates into the controls' state.
  if (settings.shake && beatPulse > 0.05) {
    shake.set(Math.random() - 0.5, Math.random() - 0.5, 0).multiplyScalar(beatPulse * 0.9);
    camera.position.add(shake);
  } else {
    shake.set(0, 0, 0);
  }
  post.render();
  camera.position.sub(shake);

  if (engine.kind === 'track' || engine.kind === 'file') updateProgress();
}

renderer.setAnimationLoop(frame);

window.addEventListener('resize', resize);

// ---------------------------------------------------------------------------
// Startup: a shared link (#track=…) waits for a click, since browsers block autoplay.
// ---------------------------------------------------------------------------

async function start(): Promise<void> {
  updateTransport();
  const params = new URLSearchParams(location.hash.slice(1));
  const id = Number(params.get('track'));
  if (!id) return;
  try {
    const t = await lookup(id, search.country);
    if (!t) {
      toast('That shared track is not available in this store.', 'error');
      return;
    }
    queue = [t];
    index = 0;
    showTrack(t);
    $<HTMLImageElement>('start-art').src = t.artwork;
    $('start-title').textContent = t.title;
    $('start-artist').textContent = t.artist;
    $('start').hidden = false;
    $('start-button').onclick = () => void playTrack(t);
    // Fill the results with more by the same artist, so next/previous have somewhere to go.
    void search.run(t.artist).then(() => {
      const more = search.results.filter((r) => r.id !== t.id);
      if (index === 0 && queue[0] === t) queue = [t, ...more];
      updateTransport();
    });
  } catch {
    toast('Could not load the shared track from iTunes.', 'error');
  }
}
void start();
// Pasting a shared link into an open tab only changes the hash, with no reload. (Our own
// replaceState calls don't fire this event.)
window.addEventListener('hashchange', () => void start());

