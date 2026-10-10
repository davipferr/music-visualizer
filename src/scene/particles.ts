import * as THREE from 'three';

import type { Palette } from '../color/palette';
import { COVER_POSITION } from './cover';

/**
 * Dust you fly through: 30k points in a box around the camera, animated entirely in the vertex
 * shader. The CPU sends five numbers a frame (time, travel distance, treble, beat, size), never
 * positions.
 *
 * - Travel: z advances by `uTravel` (integrated from loudness on the CPU, so the flight speeds up
 *   in loud passages without jumping) and wraps with mod(), so the box is endless.
 * - Treble: points swell and brighten with the high band (hats, cymbals, sibilance).
 * - Beats: a shockwave expands from the cover; points in the shell get pushed outward.
 */

const COUNT = 30_000;
const BOX = new THREE.Vector3(260, 120, 300);

const vertexShader = /* glsl */ `
  attribute float aSeed;
  uniform float uTime;
  uniform float uTravel;
  uniform float uHigh;
  uniform float uBeatAge;     // seconds since the last beat
  uniform float uBeatStrength;
  uniform float uSize;
  uniform vec3 uBox;
  uniform vec3 uOrigin;
  uniform float uPixelRatio;
  varying float vSeed;
  varying float vAlpha;

  void main() {
    vec3 p = position;
    // Endless travel toward the camera.
    p.z = mod(p.z + uTravel * (0.6 + aSeed * 0.8), uBox.z) - uBox.z * 0.75;
    // Lazy swirl.
    p.x += sin(uTime * 0.21 + aSeed * 40.0 + p.z * 0.02) * 3.0;
    p.y += cos(uTime * 0.17 + aSeed * 23.0 + p.x * 0.02) * 2.0;

    // Shockwave from the cover: a shell of radius 140·age that pushes what it passes.
    vec3 fromOrigin = p - uOrigin;
    float dist = length(fromOrigin);
    float shell = 140.0 * uBeatAge;
    float wave = exp(-pow((dist - shell) / 14.0, 2.0)) * uBeatStrength * exp(-uBeatAge * 1.8);
    p += normalize(fromOrigin) * wave * 9.0;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float size = uSize * (0.4 + aSeed) * (1.0 + 1.2 * uHigh + 1.5 * wave);
    // Perspective size, capped so the few points that pass right by the lens don't fill the screen.
    gl_PointSize = min(size * uPixelRatio * (45.0 / -mv.z), 9.0 * uPixelRatio);
    vSeed = aSeed;
    // Fade in from the far end of the box and out right in front of the lens.
    vAlpha = smoothstep(260.0, 140.0, -mv.z) * smoothstep(8.0, 40.0, -mv.z) * (0.25 + 0.45 * uHigh + 0.6 * wave);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uAccent;
  uniform vec3 uGlow;
  varying float vSeed;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d);
    vec3 col = mix(uAccent, uGlow, step(0.55, vSeed));
    gl_FragColor = vec4(col * a * vAlpha, 1.0);
  }
`;

export class Particles {
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly uniforms;
  private travel = 0;

  constructor() {
    const pos = new Float32Array(COUNT * 3);
    const seed = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      pos[i * 3] = (Math.random() - 0.5) * BOX.x;
      // Mostly above the terrain.
      pos[i * 3 + 1] = Math.pow(Math.random(), 0.7) * BOX.y - 6;
      pos[i * 3 + 2] = Math.random() * BOX.z;
      seed[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));

    this.uniforms = {
      uTime: { value: 0 },
      uTravel: { value: 0 },
      uHigh: { value: 0 },
      uBeatAge: { value: 10 },
      uBeatStrength: { value: 0 },
      uSize: { value: 1.6 },
      uBox: { value: BOX },
      uOrigin: { value: COVER_POSITION.clone() },
      uPixelRatio: { value: 1 },
      uAccent: { value: new THREE.Color() },
      uGlow: { value: new THREE.Color() },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
  }

  setPalette(p: Palette): void {
    this.uniforms.uAccent.value.setRGB(...p.accent, THREE.SRGBColorSpace);
    this.uniforms.uGlow.value.setRGB(...p.glow, THREE.SRGBColorSpace);
  }

  beat(strength: number): void {
    this.uniforms.uBeatAge.value = 0;
    this.uniforms.uBeatStrength.value = Math.min(1.5, 0.5 + 0.35 * strength);
  }

  /** @param energy overall loudness 0–1, sets flight speed */
  update(time: number, dt: number, energy: number, high: number, pixelRatio: number): void {
    this.travel += dt * (4 + 22 * energy * energy);
    const u = this.uniforms;
    u.uTime.value = time;
    u.uTravel.value = this.travel;
    u.uHigh.value = high;
    u.uBeatAge.value += dt;
    u.uPixelRatio.value = pixelRatio;
  }
}
