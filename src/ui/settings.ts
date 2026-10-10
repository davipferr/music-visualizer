/**
 * User settings, bound to `[data-setting]` inputs and remembered in localStorage (a per-viewer
 * convenience: it can be missing or throw in private mode, and the defaults apply then).
 */

export interface Settings {
  bloom: boolean;
  trails: boolean;
  lens: boolean;
  particles: boolean;
  autoCamera: boolean;
  shake: boolean;
  autoNext: boolean;
  sensitivity: number;
  volume: number;
}

export const DEFAULTS: Settings = {
  bloom: true,
  trails: true,
  lens: true,
  particles: true,
  autoCamera: true,
  shake: true,
  autoNext: true,
  sensitivity: 1,
  volume: 0.8,
};

const KEY = 'music-visualizer:settings';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    // ignore
  }
  return { ...DEFAULTS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

/** Two-way binds inputs with `data-setting="key"` to `settings`; calls `onChange` after each edit. */
export function bindSettings(root: ParentNode, settings: Settings, onChange: (key: keyof Settings) => void) {
  const inputs = [...root.querySelectorAll<HTMLInputElement>('[data-setting]')];
  const sync = () => {
    for (const input of inputs) {
      const key = input.dataset.setting as keyof Settings;
      if (input.type === 'checkbox') input.checked = settings[key] as boolean;
      else input.value = String(settings[key]);
    }
  };
  for (const input of inputs) {
    input.addEventListener('input', () => {
      const key = input.dataset.setting as keyof Settings;
      (settings[key] as boolean | number) = input.type === 'checkbox' ? input.checked : Number(input.value);
      saveSettings(settings);
      onChange(key);
    });
  }
  sync();
  return sync;
}
