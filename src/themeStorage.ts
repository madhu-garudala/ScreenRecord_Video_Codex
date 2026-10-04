export type Theme = 'light' | 'dark';

const THEME_KEY = 'onetake-theme';
const LEGACY_THEME_KEY = 'local-loom-theme';

export function readTheme(): Theme {
  const saved = window.localStorage.getItem(THEME_KEY) ?? window.localStorage.getItem(LEGACY_THEME_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function saveTheme(theme: Theme): void {
  window.localStorage.setItem(THEME_KEY, theme);
  window.localStorage.removeItem(LEGACY_THEME_KEY);
}
