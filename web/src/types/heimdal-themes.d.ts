// Types for window.HeimdalThemes — a plain global rather than a bundled
// module on purpose (see web/public/themes.js): it must run synchronously
// in <head>, before any stylesheet, to set the real CSS custom properties
// before first paint and avoid a flash of the wrong theme. Every page
// (including the auth pages) loads it the same way:
//   <script src="/themes.js"></script>
//   <script>HeimdalThemes.initTheme();</script>
export interface HeimdalTheme {
  label: string;
  accent: string;
  identity: string;
  highlight: string;
  bg: string;
  bgElevated: string;
  fg: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
}

export interface HeimdalThemesApi {
  THEMES: Record<string, HeimdalTheme>;
  initTheme(): void;
  applyTheme(name: string): void;
  setTheme(name: string): void;
  currentTheme(): string;
}

declare global {
  interface Window {
    HeimdalThemes: HeimdalThemesApi;
  }
}
