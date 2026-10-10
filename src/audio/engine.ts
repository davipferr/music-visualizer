/**
 * Web Audio graph:
 *
 *   <audio> ─ MediaElementSource ─┬─ input ─┬─ display analyser (smoothed, 4096) → visuals
 *   mic ──── MediaStreamSource ───┘         └─ onset analyser   (raw, 2048)      → beat detector
 *                                 │
 *   <audio> source ───────────────┴─ volume ─ destination
 *
 * The analysers tap the signal *before* the volume knob, so turning the volume down doesn't
 * flatten the visuals. The mic never reaches the destination (that would feed back).
 *
 * The <audio> element needs `crossOrigin = "anonymous"`: without it, a cross-origin source still
 * plays, but the browser zeroes everything the analyser sees. iTunes previews send
 * `Access-Control-Allow-Origin: *`, so they pass.
 */

export type SourceKind = 'none' | 'track' | 'file' | 'mic';

export class AudioEngine {
  readonly element: HTMLAudioElement;
  ctx: AudioContext | null = null;
  display!: AnalyserNode;
  onset!: AnalyserNode;
  private input!: GainNode;
  private volumeNode!: GainNode;
  private elementSource!: MediaElementAudioSourceNode;
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private fileUrl: string | null = null;
  private volume = 0.8;

  kind: SourceKind = 'none';
  /** Byte spectra, refreshed by `sample()`. */
  spectrum = new Uint8Array(0);
  onsetSpectrum = new Uint8Array(0);
  waveform = new Uint8Array(0);

  constructor() {
    this.element = new Audio();
    this.element.crossOrigin = 'anonymous';
    this.element.preload = 'auto';
  }

  /** Must run inside a user gesture the first time (autoplay policy). */
  async ensureContext(): Promise<AudioContext> {
    if (!this.ctx) {
      const ctx = new AudioContext();
      this.ctx = ctx;
      this.input = ctx.createGain();
      this.volumeNode = ctx.createGain();
      this.volumeNode.gain.value = this.volume;

      this.display = ctx.createAnalyser();
      this.display.fftSize = 4096;
      this.display.smoothingTimeConstant = 0.72;
      this.display.minDecibels = -90;
      this.display.maxDecibels = -20;

      this.onset = ctx.createAnalyser();
      this.onset.fftSize = 2048;
      this.onset.smoothingTimeConstant = 0;
      this.onset.minDecibels = -90;
      this.onset.maxDecibels = -20;

      this.elementSource = ctx.createMediaElementSource(this.element);
      this.elementSource.connect(this.input);
      this.elementSource.connect(this.volumeNode);
      this.volumeNode.connect(ctx.destination);
      this.input.connect(this.display);
      this.input.connect(this.onset);

      this.spectrum = new Uint8Array(this.display.frequencyBinCount);
      this.onsetSpectrum = new Uint8Array(this.onset.frequencyBinCount);
      this.waveform = new Uint8Array(1024);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return this.ctx;
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48_000;
  }

  get playing(): boolean {
    return this.kind === 'mic' || (this.kind !== 'none' && !this.element.paused && !this.element.ended);
  }

  /** Plays a URL (iTunes preview or object URL) through the element. */
  async playUrl(url: string, kind: 'track' | 'file'): Promise<void> {
    await this.ensureContext();
    this.stopMic();
    if (this.fileUrl && this.fileUrl !== url) {
      URL.revokeObjectURL(this.fileUrl);
      this.fileUrl = null;
    }
    if (kind === 'file') this.fileUrl = url;
    this.kind = kind;
    if (this.element.src !== url) this.element.src = url;
    await this.element.play();
  }

  async playFile(file: File): Promise<void> {
    await this.playUrl(URL.createObjectURL(file), 'file');
  }

  async startMic(): Promise<void> {
    await this.ensureContext();
    this.element.pause();
    if (this.micStream) return;
    // Raw signal: the browser's voice processing (echo cancel, noise suppression, AGC) is built
    // for calls and would gate or pump music.
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.micSource = this.ctx!.createMediaStreamSource(this.micStream);
    this.micSource.connect(this.input);
    this.kind = 'mic';
  }

  stopMic(): void {
    if (!this.micStream) return;
    this.micSource?.disconnect();
    for (const t of this.micStream.getTracks()) t.stop();
    this.micStream = null;
    this.micSource = null;
    if (this.kind === 'mic') this.kind = 'none';
  }

  async toggle(): Promise<void> {
    if (this.kind === 'mic') return this.stopMic();
    if (this.kind === 'none') return;
    if (this.element.paused) {
      await this.ensureContext();
      await this.element.play();
    } else {
      this.element.pause();
    }
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.volumeNode) this.volumeNode.gain.setTargetAtTime(v, this.ctx!.currentTime, 0.02);
  }

  /** Refreshes `spectrum`, `onsetSpectrum` and `waveform`. Returns false before the graph exists. */
  sample(): boolean {
    if (!this.ctx) return false;
    this.display.getByteFrequencyData(this.spectrum);
    this.onset.getByteFrequencyData(this.onsetSpectrum);
    this.display.getByteTimeDomainData(this.waveform);
    return true;
  }
}
