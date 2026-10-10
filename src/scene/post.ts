import * as THREE from 'three';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

/**
 * Render → bloom → afterimage → lens (chromatic aberration, vignette, grain) → output.
 *
 * Everything before OutputPass runs in linear HDR (half-float targets), which is what makes bloom
 * work: a peak at 3.0 blooms much more than one at 1.1, even though both display as white.
 * OutputPass then tone maps (ACES) and converts to sRGB once, at the end.
 */

const LensShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uAberration: { value: 0 },
    uVignette: { value: 0.9 },
    uGrain: { value: 0.035 },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uAberration;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uTime;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec2 c = vUv - 0.5;
      // Red and blue sampled at different radii: a cheap lens's colour fringing, stronger at
      // the edges, zero in the centre.
      vec2 off = c * dot(c, c) * uAberration;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;
      col *= mix(1.0, smoothstep(0.85, 0.2, length(c)), uVignette);
      col += (hash(vUv * 1000.0 + uTime) - 0.5) * uGrain;
      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};

export interface PostSettings {
  bloom: boolean;
  trails: boolean;
  lens: boolean;
}

export class Post {
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;
  readonly trails: AfterimagePass;
  readonly lens: ShaderPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const size = renderer.getSize(new THREE.Vector2());
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(size, 0.6, 0.5, 0.42);
    this.composer.addPass(this.bloom);
    this.trails = new AfterimagePass(0.7);
    this.composer.addPass(this.trails);
    this.lens = new ShaderPass(LensShader);
    this.composer.addPass(this.lens);
    this.composer.addPass(new OutputPass());
  }

  set(s: PostSettings): void {
    this.bloom.enabled = s.bloom;
    this.trails.enabled = s.trails;
    this.lens.enabled = s.lens;
  }

  setSize(w: number, h: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(w, h);
  }

  /** Drives the effects from the music. All inputs 0–1 except `beat` (a decaying 0–1 pulse). */
  update(time: number, bass: number, beat: number, energy: number): void {
    this.bloom.strength = 0.4 + 0.45 * bass + 0.35 * beat;
    this.bloom.radius = 0.4 + 0.2 * energy;
    // Longer trails in loud passages; quiet ones stay crisp.
    this.trails.uniforms.damp.value = 0.45 + 0.3 * energy;
    this.lens.uniforms.uAberration.value = 0.015 + 0.08 * beat;
    this.lens.uniforms.uTime.value = time % 100;
  }

  render(): void {
    this.composer.render();
  }
}
