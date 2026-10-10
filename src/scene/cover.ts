import * as THREE from 'three';

import type { Palette } from '../color/palette';

/**
 * The album cover as the scene's sun: hung over the horizon, rippling with the bass, ringed by a
 * live oscilloscope trace of the waveform and backed by an additive halo that swells on beats.
 */

const SIZE = 44;
export const COVER_POSITION = new THREE.Vector3(0, 46, -185);

const coverVertex = /* glsl */ `
  uniform float uTime;
  uniform float uBass;
  uniform float uBeat;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec3 p = position;
    // Concentric ripples from the centre, amplitude from the bass.
    float d = length(uv - 0.5);
    p.z += sin(d * 28.0 - uTime * 7.0) * (0.25 + 2.2 * uBass) * (1.0 - d);
    p *= 1.0 + 0.05 * uBeat;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const coverFragment = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uHasMap;
  uniform vec3 uAccent;
  uniform vec3 uGlow;
  uniform float uBeat;
  uniform float uTime;
  varying vec2 vUv;

  // Signed distance to a rounded square of half-size b and corner radius r.
  float roundedBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  }

  void main() {
    vec2 p = vUv - 0.5;
    float d = roundedBox(p, vec2(0.5), 0.06);
    if (d > 0.0) discard;

    vec3 art = texture2D(uMap, vUv).rgb;
    // Before a cover loads: a slow gradient in the palette colours.
    vec3 placeholder = mix(uAccent, uGlow, 0.5 + 0.5 * sin(vUv.x * 3.0 + vUv.y * 2.0 + uTime * 0.4)) * 0.35;
    vec3 col = mix(placeholder, art, uHasMap);

    // Bright rim that pulses on beats.
    float rim = smoothstep(-0.03, 0.0, d);
    col = mix(col, uGlow * 2.0, rim * (0.4 + 0.6 * uBeat));
    col *= 1.0 + 0.25 * uBeat;
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

const haloFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uStrength;
  varying vec2 vUv;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float a = pow(max(0.0, 1.0 - d), 2.4) * uStrength;
    gl_FragColor = vec4(uColor * a, 1.0);
  }
`;

const haloVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const RING_POINTS = 512;

export class Cover {
  readonly group = new THREE.Group();
  private readonly coverMat: THREE.ShaderMaterial;
  private readonly haloMat: THREE.ShaderMaterial;
  private readonly rings: THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>[] = [];
  private texture: THREE.Texture | null = null;
  private readonly blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);

  constructor() {
    this.blank.needsUpdate = true;
    this.coverMat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: this.blank },
        uHasMap: { value: 0 },
        uTime: { value: 0 },
        uBass: { value: 0 },
        uBeat: { value: 0 },
        uAccent: { value: new THREE.Color() },
        uGlow: { value: new THREE.Color() },
      },
      vertexShader: coverVertex,
      fragmentShader: coverFragment,
      side: THREE.DoubleSide,
    });
    const cover = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE, 64, 64), this.coverMat);
    cover.renderOrder = 2;

    this.haloMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color() }, uStrength: { value: 0.6 } },
      vertexShader: haloVertex,
      fragmentShader: haloFragment,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(SIZE * 3.2, SIZE * 3.2), this.haloMat);
    halo.position.z = -6;
    halo.renderOrder = 1;

    // Two traces: the waveform, and a larger, dimmer echo of it in the accent colour.
    for (const [opacity, scale] of [
      [0.95, 1],
      [0.45, 1.12],
    ]) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RING_POINTS * 3), 3));
      const mat = new THREE.LineBasicMaterial({
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const ring = new THREE.LineLoop(geo, mat);
      ring.scale.setScalar(scale);
      ring.frustumCulled = false;
      ring.renderOrder = 3;
      this.rings.push(ring);
      this.group.add(ring);
    }

    this.group.add(halo, cover);
    this.group.position.copy(COVER_POSITION);
  }

  /** Loads a CORS-enabled cover as a texture. Resolves with the image (for palette extraction). */
  async setArtwork(url: string | null): Promise<HTMLImageElement | null> {
    if (!url) {
      this.coverMat.uniforms.uHasMap.value = 0;
      this.coverMat.uniforms.uMap.value = this.blank;
      this.texture?.dispose();
      this.texture = null;
      return null;
    }
    const tex = await new THREE.TextureLoader().setCrossOrigin('anonymous').loadAsync(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    this.texture?.dispose();
    this.texture = tex;
    this.coverMat.uniforms.uMap.value = tex;
    this.coverMat.uniforms.uHasMap.value = 1;
    return tex.image as HTMLImageElement;
  }

  setPalette(p: Palette): void {
    const u = this.coverMat.uniforms;
    u.uAccent.value.setRGB(...p.accent, THREE.SRGBColorSpace);
    u.uGlow.value.setRGB(...p.glow, THREE.SRGBColorSpace);
    this.haloMat.uniforms.uColor.value.setRGB(...p.accent, THREE.SRGBColorSpace);
    this.rings[0].material.color.setRGB(...p.glow, THREE.SRGBColorSpace);
    this.rings[1].material.color.setRGB(...p.accent, THREE.SRGBColorSpace);
  }

  /**
   * @param waveform byte time-domain samples (128 = silence)
   * @param bass, beat 0–1 levels
   */
  update(time: number, waveform: Uint8Array, bass: number, beat: number, mids: number): void {
    const u = this.coverMat.uniforms;
    u.uTime.value = time;
    u.uBass.value = bass;
    u.uBeat.value = beat;
    this.haloMat.uniforms.uStrength.value = 0.25 + 0.4 * bass + 0.35 * beat;
    this.group.rotation.z = Math.sin(time * 0.13) * 0.04;

    // The trace goes round the cover: radius = base + sample. Wrapping a linear waveform onto a
    // circle leaves a seam where the last sample meets the first, so blend the last 32 samples
    // into the first ones.
    const r0 = SIZE * 0.82;
    const amp = 6 + 10 * mids;
    const n = waveform.length ? Math.min(waveform.length, RING_POINTS) : 0;
    const blend = 32;
    for (const ring of this.rings) {
      const pos = ring.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < RING_POINTS; i++) {
        let s = 0;
        if (n) {
          const j = Math.floor((i / RING_POINTS) * n);
          s = (waveform[j] - 128) / 128;
          if (j >= n - blend) {
            const t = (j - (n - blend)) / blend;
            s = s * (1 - t) + ((waveform[(j + blend) % n] - 128) / 128) * t;
          }
        }
        const a = (i / RING_POINTS) * Math.PI * 2;
        const r = r0 + s * amp;
        pos.setXYZ(i, Math.cos(a) * r, Math.sin(a) * r, 0.5);
      }
      pos.needsUpdate = true;
    }
  }
}
