import * as THREE from 'three';

import type { Palette } from '../color/palette';
import { SpectrumHistory } from './history';

/**
 * A landscape made of sound: the last few seconds of spectrum, displaced on the GPU.
 *
 * x is frequency, mirrored about the centre line (bass in the middle valley, treble at both
 * edges), and z is time, with "now" at the near edge and history scrolling toward the horizon.
 * The vertex shader samples the history texture for height, so the CPU only uploads 64 kB per
 * frame; 260k vertices are never touched from JavaScript.
 */

export const BANDS = 256;
export const ROWS = 256;

const WIDTH = 160;
const DEPTH = 220;

const vertexShader = /* glsl */ `
  uniform sampler2D uHistory;
  uniform float uHead;     // newest row / rows, so (v + uHead) reads in time order
  uniform float uHeight;
  uniform float uTime;
  uniform float uIdle;     // 1 when nothing is playing

  varying float vHeight;
  varying float vAge;
  varying vec2 vGrid;
  varying float vFog;

  float sampleHeight(vec2 uv) {
    // u: 0 at the centre line → 1 at the edges, so bass sits in the middle.
    float freq = abs(uv.x * 2.0 - 1.0);
    // Push the first band a little off-centre so the valley floor is a flat river, not a spike.
    freq = clamp((freq - 0.03) / 0.97, 0.0, 1.0);
    float age = uv.y; // 0 = now, 1 = oldest
    // Texel centres: newest row (head − 1) at age 0, oldest row (head) at age 1.
    float row = uHead - 0.5 / ${ROWS}.0 - age * (1.0 - 1.0 / ${ROWS}.0);
    float h = texture2D(uHistory, vec2(freq, row)).r;
    // Treble is quieter than bass in every mix; tilt it up so the edges have mountains too.
    h *= mix(1.0, 1.45, freq);
    // Idle breathing so the scene isn't dead before the first song.
    float idle = 0.08 * (sin(uv.x * 18.0 + uTime * 0.7) * sin(uv.y * 11.0 - uTime * 0.5) + 1.0);
    return mix(h, idle, uIdle);
  }

  void main() {
    vec2 uv = uv;
    float h = sampleHeight(uv);
    vec3 p = position;
    // Keep a lower valley down the middle so the camera can see the cover over it.
    p.y += h * uHeight * (0.55 + 0.45 * smoothstep(0.0, 0.3, abs(uv.x * 2.0 - 1.0)));
    vHeight = h;
    vAge = uv.y;
    vGrid = vec2(uv.x * 96.0, uv.y * 96.0);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vFog = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uBase;
  uniform vec3 uMid;
  uniform vec3 uAccent;
  uniform vec3 uGlow;
  uniform float uBeat;
  uniform float uFogNear;
  uniform float uFogFar;

  varying float vHeight;
  varying float vAge;
  varying vec2 vGrid;
  varying float vFog;

  // Anti-aliased grid lines: fwidth scales the line by how fast the grid changes on screen, so
  // lines stay ~1 px wide at any distance instead of shimmering.
  float gridLine(vec2 g) {
    vec2 w = fwidth(g);
    vec2 a = abs(fract(g - 0.5) - 0.5) / max(w, 1e-4);
    return 1.0 - min(min(a.x, a.y), 1.0);
  }

  void main() {
    float h = clamp(vHeight, 0.0, 1.2);
    vec3 col = mix(uBase, uMid, smoothstep(0.02, 0.35, h));
    col = mix(col, uAccent, smoothstep(0.3, 0.75, h));
    col = mix(col, uGlow, smoothstep(0.75, 1.05, h));

    // Grid glows brighter on peaks and on beats; it fades with distance to avoid moiré.
    float line = gridLine(vGrid) * (1.0 - smoothstep(60.0, 180.0, vFog));
    col += line * mix(uMid * 1.4, uAccent * 2.2, h) * (0.35 + 0.9 * uBeat);

    // Fresh sound (near edge) is brightest; history dims as it travels away.
    col *= mix(1.25, 0.55, vAge);

    float fog = smoothstep(uFogNear, uFogFar, vFog);
    gl_FragColor = vec4(mix(col, uBase * 0.6, fog), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class Terrain {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  readonly history = new SpectrumHistory(BANDS, ROWS);
  private readonly texture: THREE.DataTexture;
  readonly uniforms;

  constructor() {
    this.texture = new THREE.DataTexture(this.history.data, BANDS, ROWS, THREE.RedFormat, THREE.UnsignedByteType);
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.RepeatWrapping;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    // R8 rows of 256 bytes are 4-byte aligned already, but say so explicitly for other widths.
    this.texture.unpackAlignment = 1;
    this.texture.needsUpdate = true;

    this.uniforms = {
      uHistory: { value: this.texture },
      uHead: { value: 0 },
      uHeight: { value: 19 },
      uTime: { value: 0 },
      uIdle: { value: 1 },
      uBeat: { value: 0 },
      uBase: { value: new THREE.Color() },
      uMid: { value: new THREE.Color() },
      uAccent: { value: new THREE.Color() },
      uGlow: { value: new THREE.Color() },
      uFogNear: { value: 70 },
      uFogFar: { value: 230 },
    };

    const geo = new THREE.PlaneGeometry(WIDTH, DEPTH, 511, 511);
    geo.rotateX(-Math.PI / 2);
    // uv.y = 0 at the near edge (+z, toward the camera), 1 at the horizon.
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
    geo.translate(0, 0, -DEPTH / 2 + 30);

    const mat = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader, fragmentShader });
    this.mesh = new THREE.Mesh(geo, mat);
    // The vertex shader moves vertices up to uHeight; the CPU-side bounds don't know that.
    this.mesh.frustumCulled = false;
  }

  push(bands: Float32Array): void {
    this.history.push(bands);
    this.texture.needsUpdate = true;
    this.uniforms.uHead.value = this.history.head / ROWS;
  }

  setPalette(p: Palette): void {
    // Palette colours come from an sRGB image; the shader works in linear.
    this.uniforms.uBase.value.setRGB(...p.base, THREE.SRGBColorSpace);
    this.uniforms.uMid.value.setRGB(...p.mid, THREE.SRGBColorSpace);
    this.uniforms.uAccent.value.setRGB(...p.accent, THREE.SRGBColorSpace);
    this.uniforms.uGlow.value.setRGB(...p.glow, THREE.SRGBColorSpace);
  }
}
