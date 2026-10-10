import { RateLimitError, search, type Track } from '../data/itunes';

const SUGGESTIONS = [
  'Tom Jobim',
  'Daft Punk',
  'Caetano Veloso',
  'Billie Eilish',
  'Aphex Twin',
  'Radiohead',
  'Kendrick Lamar',
];

const COUNTRIES: [string, string][] = [
  ['BR', '🇧🇷'],
  ['US', '🇺🇸'],
  ['GB', '🇬🇧'],
  ['PT', '🇵🇹'],
  ['CA', '🇨🇦'],
  ['MX', '🇲🇽'],
  ['AR', '🇦🇷'],
  ['ES', '🇪🇸'],
  ['FR', '🇫🇷'],
  ['DE', '🇩🇪'],
  ['JP', '🇯🇵'],
  ['KR', '🇰🇷'],
  ['AU', '🇦🇺'],
];

/**
 * Search box, suggestion chips and results list. Typing searches after a pause (the API allows
 * ~20 calls a minute), Enter searches immediately, and a newer search aborts the older one.
 */
export class SearchPanel {
  results: Track[] = [];
  private timer = 0;
  private abort: AbortController | null = null;
  private currentId: number | null = null;

  constructor(
    private readonly els: {
      form: HTMLFormElement;
      input: HTMLInputElement;
      country: HTMLSelectElement;
      chips: HTMLElement;
      status: HTMLElement;
      list: HTMLUListElement;
    },
    country: string,
    private readonly onPick: (results: Track[], index: number) => void,
  ) {
    const known = COUNTRIES.some(([c]) => c === country);
    for (const [code, flag] of known ? COUNTRIES : [[country, '🌐'] as [string, string], ...COUNTRIES]) {
      els.country.add(new Option(`${flag} ${code}`, code));
    }
    els.country.value = country;

    for (const s of SUGGESTIONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = s;
      b.addEventListener('click', () => {
        els.input.value = s;
        void this.run();
      });
      els.chips.append(b);
    }

    els.form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.run();
    });
    els.input.addEventListener('input', () => {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.run(), 550);
    });
    els.country.addEventListener('change', () => void this.run());
  }

  get country(): string {
    return this.els.country.value;
  }

  get term(): string {
    return this.els.input.value.trim();
  }

  async run(term = this.term): Promise<void> {
    clearTimeout(this.timer);
    if (term.length < 2) return;
    this.els.input.value = term;
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    this.status('Searching…');
    try {
      const tracks = await search(term, this.country, abort.signal);
      if (abort.signal.aborted) return;
      this.results = tracks;
      this.render();
      this.status(tracks.length ? '' : `No previews found for “${term}” in the ${this.country} store.`);
    } catch (err) {
      if (abort.signal.aborted) return;
      // Over the limit, iTunes drops the CORS header, so the browser reports a bare network error.
      const limited = err instanceof RateLimitError || err instanceof TypeError;
      this.status(
        limited
          ? 'iTunes refused the request. That is usually its rate limit (about 20 searches a minute), so wait a moment and try again.'
          : `Search failed: ${(err as Error).message}`,
      );
    }
  }

  setCurrent(id: number | null): void {
    this.currentId = id;
    for (const li of this.els.list.children) {
      li.classList.toggle('current', Number((li as HTMLElement).dataset.id) === id);
    }
  }

  private status(msg: string): void {
    this.els.status.textContent = msg;
    this.els.status.hidden = !msg;
  }

  private render(): void {
    const list = this.els.list;
    list.replaceChildren();
    this.results.forEach((t, i) => {
      const li = document.createElement('li');
      li.tabIndex = 0;
      li.dataset.id = String(t.id);
      li.classList.toggle('current', t.id === this.currentId);
      const img = document.createElement('img');
      img.src = t.thumb;
      img.alt = '';
      img.loading = 'lazy';
      const meta = document.createElement('div');
      meta.className = 'meta';
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = t.title;
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = [t.artist, t.album, t.year].filter(Boolean).join(' · ');
      meta.append(title, sub);
      li.append(img, meta);
      const pick = () => this.onPick(this.results, i);
      li.addEventListener('click', pick);
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') pick();
      });
      list.append(li);
    });
    list.scrollTop = 0;
  }
}
