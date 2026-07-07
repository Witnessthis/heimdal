// Shared terminal-inspired color themes for the whole app. Applied as CSS
// custom properties on :root, so any page picks this up with the same two
// lines in <head>: `<script src="/themes.js"></script>` followed by
// `<script>HeimdalThemes.initTheme();</script>`, run before the page's own
// <style> block so there's never a flash of the wrong theme.
//
// Palettes are real, published terminal color schemes (see
// https://terminalcolors.com/), reduced to the handful of slots this app
// actually uses: a background/elevated-background pair, foreground, and
// the 8 standard ANSI colors. "heimdal" is the app's original hand-picked
// palette, kept as the default.
(function (global) {
  const THEMES = {
    heimdal: {
      label: 'Heimdal',
      accent: '#e94560',
      identity: '#5ac7c0',
      highlight: '#f6d32d',
      bg: '#1a1a2e',
      bgElevated: '#16162e',
      fg: '#f1f1f1',
      black: '#0d0d1a',
      red: '#e94560',
      green: '#4caf50',
      yellow: '#f6d32d',
      blue: '#5a7dc7',
      magenta: '#c73a52',
      cyan: '#5ac7c0',
      white: '#f1f1f1',
      brightBlack: '#6a6a7a',
    },
    dracula: {
      label: 'Dracula',
      accent: '#bd93f9',
      identity: '#50fa7b',
      highlight: '#ff79c6',
      bg: '#282a36',
      bgElevated: '#21222c',
      fg: '#f8f8f2',
      black: '#21222c',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightBlack: '#6272a4',
    },
    nord: {
      label: 'Nord',
      accent: '#88c0d0',
      identity: '#a3be8c',
      highlight: '#ebcb8b',
      bg: '#2e3440',
      bgElevated: '#3b4252',
      fg: '#d8dee9',
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0',
      brightBlack: '#4c566a',
    },
    gruvbox: {
      label: 'Gruvbox Dark',
      accent: '#fe8019',
      identity: '#689d6a',
      highlight: '#d79921',
      bg: '#282828',
      bgElevated: '#3c3836',
      fg: '#ebdbb2',
      black: '#282828',
      red: '#cc241d',
      green: '#98971a',
      yellow: '#d79921',
      blue: '#458588',
      magenta: '#b16286',
      cyan: '#689d6a',
      white: '#a89984',
      brightBlack: '#928374',
    },
    solarizedDark: {
      label: 'Solarized Dark',
      accent: '#268bd2',
      identity: '#2aa198',
      highlight: '#b58900',
      bg: '#002b36',
      bgElevated: '#073642',
      fg: '#839496',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#586e75',
    },
    solarizedLight: {
      label: 'Solarized Light',
      accent: '#268bd2',
      identity: '#2aa198',
      highlight: '#b58900',
      bg: '#fdf6e3',
      bgElevated: '#eee8d5',
      fg: '#657b83',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#073642',
      brightBlack: '#93a1a1',
    },
    tokyoNight: {
      label: 'Tokyo Night',
      accent: '#7aa2f7',
      identity: '#7dcfff',
      highlight: '#e0af68',
      bg: '#1a1b26',
      bgElevated: '#24283b',
      fg: '#c0caf5',
      black: '#15161e',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#a9b1d6',
      brightBlack: '#414868',
    },
    catppuccinMocha: {
      label: 'Catppuccin Mocha',
      accent: '#cba6f7',
      identity: '#89b4fa',
      highlight: '#f9e2af',
      bg: '#1e1e2e',
      bgElevated: '#313244',
      fg: '#cdd6f4',
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#f5c2e7',
      cyan: '#94e2d5',
      white: '#bac2de',
      brightBlack: '#585b70',
    },
    oneDark: {
      label: 'One Dark',
      accent: '#61afef',
      identity: '#98c379',
      highlight: '#e5c07b',
      bg: '#282c34',
      bgElevated: '#21252b',
      fg: '#abb2bf',
      black: '#282c34',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#e5c07b',
      blue: '#61afef',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#abb2bf',
      brightBlack: '#5c6370',
    },
    rosePine: {
      label: 'Rosé Pine',
      accent: '#eb6f92',
      identity: '#c4a7e7',
      highlight: '#f6c177',
      bg: '#191724',
      bgElevated: '#1f1d2e',
      fg: '#e0def4',
      black: '#26233a',
      red: '#eb6f92',
      green: '#31748f',
      yellow: '#f6c177',
      blue: '#9ccfd8',
      magenta: '#c4a7e7',
      cyan: '#ebbcba',
      white: '#e0def4',
      brightBlack: '#6e6a86',
    },
    everforest: {
      label: 'Everforest',
      accent: '#a7c080',
      identity: '#83c092',
      highlight: '#dbbc7f',
      bg: '#2d353b',
      bgElevated: '#343f44',
      fg: '#d3c6aa',
      black: '#4b565c',
      red: '#e67e80',
      green: '#a7c080',
      yellow: '#dbbc7f',
      blue: '#7fbbb3',
      magenta: '#d699b6',
      cyan: '#83c092',
      white: '#d3c6aa',
      brightBlack: '#7a8478',
    },
    monokai: {
      label: 'Monokai',
      accent: '#f92672',
      identity: '#a6e22e',
      highlight: '#f4bf75',
      bg: '#272822',
      bgElevated: '#1e1f1c',
      fg: '#f8f8f2',
      black: '#272822',
      red: '#f92672',
      green: '#a6e22e',
      yellow: '#f4bf75',
      blue: '#66d9ef',
      magenta: '#ae81ff',
      cyan: '#a1efe4',
      white: '#f8f8f2',
      brightBlack: '#75715e',
    },
  };

  const STORAGE_KEY = 'heimdal-theme';
  const DEFAULT_THEME = 'heimdal';

  function resolve(name) {
    return THEMES[name] ? name : DEFAULT_THEME;
  }

  function applyTheme(name) {
    const theme = THEMES[resolve(name)];
    const root = document.documentElement.style;
    root.setProperty('--bg', theme.bg);
    root.setProperty('--bg-elevated', theme.bgElevated);
    root.setProperty('--fg', theme.fg);
    root.setProperty('--fg-dim', `color-mix(in srgb, ${theme.fg}, ${theme.bg} 45%)`);
    root.setProperty('--muted', theme.brightBlack);
    // The brand/interactive color (logo, card border, active states) is
    // each theme's own chosen signature color — not tied to any one ANSI
    // slot, so it doesn't have to be red/pink just because Heimdal's
    // original palette was. --danger stays pinned to the theme's actual
    // ANSI red regardless, for the one spot (logging out) where "red
    // means be careful" is the point.
    root.setProperty('--accent', theme.accent);
    root.setProperty('--accent-soft', `color-mix(in srgb, ${theme.accent}, transparent 65%)`);
    root.setProperty('--danger', theme.red);
    root.setProperty('--success', theme.green);
    // Same idea as --accent above: each theme's own curated colors, not a
    // fixed ANSI slot reused everywhere (identity was always turning out
    // blue-ish, highlight always yellow-ish, regardless of theme).
    root.setProperty('--identity', theme.identity);
    root.setProperty('--highlight', theme.highlight);
    // Unlike --identity/--highlight above, this one *is* meant to be
    // "whatever blue this theme has" — Cc/Bcc just need a color distinct
    // from To (--identity) and the rest (--accent), and each theme's own
    // ANSI blue is already a real, curated color from that published
    // palette rather than an arbitrary pick.
    root.setProperty('--info', theme.blue);
    root.setProperty('--border-soft', `color-mix(in srgb, ${theme.fg}, ${theme.bg} 88%)`);

    document.documentElement.dataset.theme = resolve(name);

    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta) themeColorMeta.setAttribute('content', theme.bg);
  }

  function currentTheme() {
    return resolve(localStorage.getItem(STORAGE_KEY));
  }

  function setTheme(name) {
    localStorage.setItem(STORAGE_KEY, resolve(name));
    applyTheme(name);
  }

  function initTheme() {
    applyTheme(currentTheme());
  }

  global.HeimdalThemes = { THEMES, initTheme, applyTheme, setTheme, currentTheme };
})(window);
