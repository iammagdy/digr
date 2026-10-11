export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "digr:theme";

export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ThemeRoot {
  dataset: { theme?: string };
}

export function getStoredTheme(storage: ThemeStorage | null): Theme | null {
  if (!storage) return null;
  try {
    const saved = storage.getItem(THEME_STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : null;
  } catch {
    return null;
  }
}

export function resolveTheme(preference: Theme | null, systemPrefersDark: boolean): Theme {
  return preference ?? (systemPrefersDark ? "dark" : "light");
}

export function applyTheme(theme: Theme, root: ThemeRoot): void {
  root.dataset.theme = theme;
}

export function initializeTheme(
  storage: ThemeStorage | null,
  systemPrefersDark: boolean,
  root: ThemeRoot,
): Theme {
  const theme = resolveTheme(getStoredTheme(storage), systemPrefersDark);
  applyTheme(theme, root);
  return theme;
}

export function persistTheme(theme: Theme, storage: ThemeStorage | null, root: ThemeRoot): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The selected theme still applies when browser storage is unavailable.
  }
  applyTheme(theme, root);
}

export function applySystemThemeIfUnselected(
  systemPrefersDark: boolean,
  storage: ThemeStorage | null,
  root: ThemeRoot,
): boolean {
  if (getStoredTheme(storage)) return false;
  applyTheme(resolveTheme(null, systemPrefersDark), root);
  return true;
}

export const themeInitializationScript = `(()=>{let saved=null;try{saved=window.localStorage.getItem("${THEME_STORAGE_KEY}")}catch{}const dark=window.matchMedia?.("(prefers-color-scheme: dark)").matches??false;document.documentElement.dataset.theme=saved==="light"||saved==="dark"?saved:dark?"dark":"light"})()`;
