/**
 * iTunes Search API: https://performance-partners.apple.com/search-api
 *
 * Free, keyless, CORS-enabled (`Access-Control-Allow-Origin: *`), and so are the 30-second
 * previews and the artwork, which is what lets the analyser read the audio and WebGL read the
 * cover. Apple documents a limit of "about 20 calls per minute", so searches are debounced by the
 * caller and every response is memoised for the session.
 */

const BASE = 'https://itunes.apple.com';

export interface Track {
  id: number;
  title: string;
  artist: string;
  album: string;
  /** 600×600 cover. */
  artwork: string;
  /** 100×100 cover, for lists. */
  thumb: string;
  preview: string;
  durationMs: number;
  genre: string;
  year: number | null;
  url: string;
}

/** Fields of a search/lookup result that we use. */
export interface ItunesResult {
  wrapperType?: string;
  kind?: string;
  trackId?: number;
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  artworkUrl100?: string;
  previewUrl?: string;
  trackTimeMillis?: number;
  primaryGenreName?: string;
  releaseDate?: string;
  trackViewUrl?: string;
}

/**
 * Artwork URLs end in `/{w}x{h}bb.jpg`. The CDN renders any size on request, so swap the size in
 * the path rather than upscaling the 100 px image.
 */
export function artworkAt(url: string, size: number): string {
  return url.replace(/\/\d+x\d+(bb|cc|sr)?\.(jpg|png|webp)$/, `/${size}x${size}bb.jpg`);
}

/** Converts a raw result to a Track, or null when it can't be played (no preview, not a song). */
export function toTrack(r: ItunesResult): Track | null {
  if (r.wrapperType !== 'track' || r.kind !== 'song' || !r.previewUrl || !r.trackId) return null;
  const art = r.artworkUrl100 ?? '';
  const year = r.releaseDate ? new Date(r.releaseDate).getUTCFullYear() : NaN;
  return {
    id: r.trackId,
    title: r.trackName ?? 'Unknown',
    artist: r.artistName ?? 'Unknown',
    album: r.collectionName ?? '',
    artwork: art && artworkAt(art, 600),
    thumb: art && artworkAt(art, 120),
    preview: r.previewUrl,
    durationMs: r.trackTimeMillis ?? 0,
    genre: r.primaryGenreName ?? '',
    year: Number.isFinite(year) ? year : null,
    url: r.trackViewUrl ?? '',
  };
}

export class RateLimitError extends Error {}

const cache = new Map<string, Promise<Track[]>>();

async function get(url: string, signal?: AbortSignal): Promise<Track[]> {
  const res = await fetch(url, { signal });
  // Over the limit, iTunes answers 403 (sometimes 429) with no CORS header, which surfaces as a
  // network TypeError rather than a status, so both are treated as rate limiting.
  if (res.status === 403 || res.status === 429) throw new RateLimitError('iTunes rate limit');
  if (!res.ok) throw new Error(`iTunes ${res.status}`);
  const body = (await res.json()) as { results: ItunesResult[] };
  const tracks: Track[] = [];
  for (const r of body.results) {
    const t = toTrack(r);
    if (t) tracks.push(t);
  }
  return tracks;
}

function memo(url: string, signal?: AbortSignal): Promise<Track[]> {
  let p = cache.get(url);
  if (!p) {
    p = get(url, signal);
    cache.set(url, p);
    p.catch(() => cache.delete(url)); // don't memoise failures
  }
  return p;
}

export function searchUrl(term: string, country: string, limit = 30): string {
  const q = new URLSearchParams({ term: term.trim(), media: 'music', entity: 'song', limit: String(limit), country });
  return `${BASE}/search?${q}`;
}

export function search(term: string, country: string, signal?: AbortSignal): Promise<Track[]> {
  return memo(searchUrl(term, country), signal);
}

export async function lookup(id: number, country: string): Promise<Track | null> {
  const tracks = await memo(`${BASE}/lookup?id=${id}&country=${country}`);
  return tracks[0] ?? null;
}

/** Store front from the browser language (pt-BR → BR); iTunes catalogues differ by country. */
export function defaultCountry(lang = navigator.language): string {
  const m = /[-_]([A-Za-z]{2})$/.exec(lang);
  return m ? m[1].toUpperCase() : 'US';
}
