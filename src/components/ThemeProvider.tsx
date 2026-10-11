"use client";

import { createContext, useCallback, useContext, useEffect, type ReactNode } from "react";
import { applySystemThemeIfUnselected, persistTheme, type Theme } from "@/lib/theme";

type ThemeContextValue = { toggleTheme: () => void };
const ThemeContext = createContext<ThemeContextValue>({ toggleTheme: () => undefined });

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const toggleTheme = useCallback(() => {
    const root = document.documentElement;
    const current: Theme = root.dataset.theme === "dark" ? "dark" : "light";
    persistTheme(current === "dark" ? "light" : "dark", browserStorage(), root);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const syncWithSystem = (event: MediaQueryListEvent) => {
      applySystemThemeIfUnselected(event.matches, browserStorage(), document.documentElement);
    };

    applySystemThemeIfUnselected(media.matches, browserStorage(), document.documentElement);
    media.addEventListener("change", syncWithSystem);
    return () => media.removeEventListener("change", syncWithSystem);
  }, []);

  return <ThemeContext.Provider value={{ toggleTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
