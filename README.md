# Music Visualizer

Search any song and watch it as a 3D landscape. Built with **TypeScript + Vite + Three.js** on the
**[iTunes Search API](https://performance-partners.apple.com/search-api)** (free, no key, CORS-enabled)
and the **Web Audio API**. Every song gets a 30-second preview, and the scene takes its colours from
the album cover.

```bash
npm install
npm run dev
```

`npm test` runs the unit tests. `npm run build` type-checks and builds to `dist/`, which deploys to GitHub
Pages through [.github/workflows/ci.yml](.github/workflows/ci.yml). Enable Pages with source "GitHub Actions"
in the repo settings.

You can also visualize your **microphone** or **drop an audio file** anywhere on the page.

## Controls

| | |
|---|---|
| <kbd>Space</kbd> | Play / pause |
| <kbd>N</kbd> <kbd>P</kbd> | Next / previous result |
| <kbd>←</kbd> <kbd>→</kbd> | Seek 5 s |
| <kbd>/</kbd> | Search |
| <kbd>M</kbd> | Microphone on / off |
| <kbd>C</kbd> | Auto camera on / off (dragging the view turns it off) |
| <kbd>H</kbd> | Hide the interface (double-click the scene to bring it back) |
| <kbd>F</kbd> | Fullscreen |

The URL keeps the track (`#track=697195462&country=BR`), so you can share a link to a song. Browsers block
autoplay, so a shared link opens with a "Click to play" card.

## What's on screen

- **Terrain**: a scrolling spectrogram. Left-right is frequency, mirrored so the bass runs down the middle
  valley and the treble rises at both edges. Front-to-back is time, with "now" at the near edge and the last
  ~4 seconds flowing toward the horizon.
- **Cover**: the album art as the sun, rippling with the bass and pulsing on beats, ringed by a live
  oscilloscope trace of the waveform.
- **Particles**: dust you fly through. You fly faster when the music is loud, the dust swells with the
  treble, and every beat sends a shockwave out from the cover.
- **Post-processing**: bloom driven by the bass, motion trails that lengthen in loud passages, and colour
  fringing that kicks on beats.

## How it works

| Piece | File | Notes |
|---|---|---|
| iTunes client | [src/data/itunes.ts](src/data/itunes.ts) | Search and lookup, memoised. Artwork URLs end in `/100x100bb.jpg` and the CDN renders any size, so the cover is requested at 600 px. The API allows ~20 calls a minute: typing waits 550 ms, and a newer search aborts the older one. Over the limit, iTunes drops the CORS header, so the browser only sees a network error. That's treated as rate limiting. |
| Audio graph | [src/audio/engine.ts](src/audio/engine.ts) | `<audio crossOrigin="anonymous">` → two analysers (a smoothed 4096-point FFT for visuals, a raw 2048-point FFT for onsets), plus a separate path through the volume knob. The analysers tap the signal *before* the volume, so turning it down doesn't flatten the visuals. Without `crossOrigin`, a cross-origin preview still plays, but the analyser reads silence. |
| Log bins | [src/audio/analysis.ts](src/audio/analysis.ts) | FFT bins are spaced linearly, but pitch is heard logarithmically (the octave 440→880 Hz spans 41 bins, the next one 82). The spectrum is resampled onto 256 log-spaced bands from 30 Hz to 16 kHz. Wide treble bands take the max of their bins. Deep bass bands, narrower than one bin, interpolate. |
| Envelopes, auto-gain | [src/audio/analysis.ts](src/audio/analysis.ts) | Attack/release smoothing based on time constants, so it behaves the same at 30 and 144 fps. Each band is normalised by a slowly decaying running peak, so a quiet acoustic track and a loud EDM master both fill the scene. |
| Beats | [src/audio/analysis.ts](src/audio/analysis.ts) | Spectral flux in the bass (how much each bin got louder since the last frame) against an adaptive `mean + 1.6σ` threshold over the last 1.5 s. Steady bass gives no flux; a kick gives a spike. |
| Tempo | [src/audio/analysis.ts](src/audio/analysis.ts) | Gaps between beats fail on syncopated music ("Get Lucky" read 150 instead of 116), so tempo comes from **autocorrelation** of wide-band flux over 8 s instead. That flux is resampled to 50 Hz and lightly smoothed. Peaks are weighted by a prior centred on 120 BPM to pick the right octave, the peak position is refined with a parabola, and the reported tempo is the median of recent estimates. |
| Palette | [src/color/palette.ts](src/color/palette.ts) | k-means (seeded k-means++) on a 48×48 copy of the cover. Colours get roles by what the scene needs, not by how common they are: the most vivid cluster becomes the accent, a dark version of the background becomes the base. Greyscale covers fall back to a default palette, and palettes cross-fade over 1.4 s. |
| Terrain | [src/scene/terrain.ts](src/scene/terrain.ts), [history.ts](src/scene/history.ts) | A 256×256 one-byte `DataTexture` used as a ring buffer: each frame overwrites one row and the shader offsets its texture lookup by the head position, so nothing is ever shifted. Rows are pushed at a fixed 60 Hz, so it scrolls at the same speed at any frame rate. The vertex shader displaces 262k vertices from the texture, and the fragment shader draws anti-aliased grid lines with `fwidth`. |
| Cover | [src/scene/cover.ts](src/scene/cover.ts) | Rounded corners come from a signed-distance function in the fragment shader. The waveform ring blends its last samples into its first, so it has no seam. |
| Particles | [src/scene/particles.ts](src/scene/particles.ts) | 30k points animated entirely in the vertex shader. The CPU sends a handful of uniforms per frame, never positions. Flight distance is integrated on the CPU, so speeding up never makes the dust jump. |
| Post | [src/scene/post.ts](src/scene/post.ts) | Render → bloom → afterimage → lens (chromatic aberration, vignette, grain) → output. Everything before the output pass is linear HDR, which is what lets bright peaks bloom more than dim ones. |
| Resolution | [src/scene/quality.ts](src/scene/quality.ts) | The effects are fill-rate bound: on an Intel Iris Xe, GPU time goes from 9 ms to 16 ms between pixel ratio 1.25 and 1.5. So the ratio adapts to measured frame times. Slow frames lower it, and the failed ratio becomes a ceiling, so it never oscillates. If two lower steps don't speed things up, the bottleneck is elsewhere (CPU, or a browser capping the frame rate), so it restores the original ratio rather than blurring the picture for nothing. |

## Notes

- Previews are 30 s, AAC in an `.m4a`. Every current browser plays them.
- iTunes catalogues differ by country. The store front defaults to your browser language (pt-BR → BR) and
  can be changed next to the search box.
- The microphone is opened with echo cancellation, noise suppression and auto-gain **off**. Those are built
  for calls and would gate or pump music.
- Settings are stored in `localStorage`. Without it (private mode), the defaults apply.
