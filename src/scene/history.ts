/**
 * A scrolling spectrogram stored as a ring buffer: `rows` spectra of `width` log bands, one byte
 * each. Each frame overwrites one row instead of shifting the whole image, and the shader adds
 * `head / rows` to its texture coordinate (with RepeatWrapping) to read rows in time order. That
 * makes an upload of the whole texture the only per-frame cost, and with 256×256 bytes it's 64 kB.
 */
export class SpectrumHistory {
  readonly data: Uint8Array;
  /** Row the *next* push writes to; the newest row is head − 1. */
  head = 0;

  constructor(
    readonly width: number,
    readonly rows: number,
  ) {
    this.data = new Uint8Array(width * rows);
  }

  /** Writes one spectrum (values 0–1, length = width) as the newest row. */
  push(row: ArrayLike<number>): void {
    const o = this.head * this.width;
    for (let i = 0; i < this.width; i++) this.data[o + i] = Math.round(Math.min(1, Math.max(0, row[i])) * 255);
    this.head = (this.head + 1) % this.rows;
  }

  clear(): void {
    this.data.fill(0);
  }
}
