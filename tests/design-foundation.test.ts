import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applySystemThemeIfUnselected,
  initializeTheme,
  persistTheme,
  THEME_STORAGE_KEY,
  themeInitializationScript,
  type ThemeStorage,
} from "../src/lib/theme";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const digest = (path: string) => createHash("sha256").update(readFileSync(resolve(process.cwd(), path))).digest("hex");

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage: ThemeStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
  return { storage, values };
}

describe("theme initialization and persistence", () => {
  it("uses the saved preference before the system setting", () => {
    const { storage } = memoryStorage({ [THEME_STORAGE_KEY]: "light" });
    const root = { dataset: {} as { theme?: string } };

    expect(initializeTheme(storage, true, root)).toBe("light");
    expect(root.dataset.theme).toBe("light");
  });

  it("uses the system preference when no explicit choice is saved", () => {
    const root = { dataset: {} as { theme?: string } };

    expect(initializeTheme(null, true, root)).toBe("dark");
    expect(initializeTheme(null, false, root)).toBe("light");
  });

  it("persists an explicit selection and applies it immediately", () => {
    const { storage, values } = memoryStorage();
    const root = { dataset: {} as { theme?: string } };

    persistTheme("dark", storage, root);

    expect(values.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(root.dataset.theme).toBe("dark");
  });

  it("follows system changes until the user selects a theme", () => {
    const { storage } = memoryStorage();
    const root = { dataset: {} as { theme?: string } };

    expect(applySystemThemeIfUnselected(true, storage, root)).toBe(true);
    expect(root.dataset.theme).toBe("dark");
    persistTheme("light", storage, root);
    expect(applySystemThemeIfUnselected(true, storage, root)).toBe(false);
    expect(root.dataset.theme).toBe("light");
  });

  it("provides a pre-hydration initializer to avoid a theme flash", () => {
    expect(themeInitializationScript).toContain(`localStorage.getItem("${THEME_STORAGE_KEY}")`);
    expect(themeInitializationScript).toContain("prefers-color-scheme: dark");
    expect(themeInitializationScript).toContain("document.documentElement.dataset.theme");
  });
});

describe("approved visual foundation", () => {
  it("defines the approved light, dark, and admin token values", () => {
    const css = read("src/app/globals.css");
    for (const token of [
      "--bg: #FAF8F4", "--sf: #FFFFFF", "--sf2: #F2EFE9", "--ln: #E8E4DC",
      "--ink: #16201F", "--ac: #0E3B43", "--gold: #C8963E", "--ok: #2F7A4F",
      "--bg: #111413", "--sf: #171B1A", "--goldT: #D4A65A", "--bad: #F08A7C",
      "--bg: #F6F4EF", "--bg: #0F1211", "--info: #2B5F8A", "--bar: #A9D5D9",
      "--ease-digr: cubic-bezier(.2, .7, .2, 1)",
    ]) expect(css).toContain(token);
    expect(css).toContain("@theme {");
    expect(css).toContain("[data-theme=\"light\"]");
    expect(css).toContain("[data-theme=\"dark\"]");
  });

  it("uses the approved fonts and retains Arabic RTL document metadata", () => {
    const layout = read("src/app/layout.tsx");
    const css = read("src/app/globals.css");
    expect(layout).toContain("Vazirmatn({");
    expect(layout).toContain('weight: ["300", "400", "500", "600"]');
    expect(layout).toContain("Markazi_Text({");
    expect(layout).toContain('weight: ["500", "600"]');
    expect(layout).toContain('<html lang="ar" dir="rtl"');
    expect(css).toContain("var(--font-vazirmatn)");
    expect(css).toContain("var(--font-markazi)");
  });

  it("ships unmodified supplied logos and both favicon entries", () => {
    const expected = {
      "public/brand/digr-wordmark.svg": "8dc905aa0b683f3f6b5c597d8b5a6c3f021a6efbebefa99faf23cb2137588ac8",
      "public/brand/digr-wordmark-white.svg": "d807db51f579158785f2dd8232688939d4bc907d4283614c2147d5b30912ac6b",
      "public/brand/digr-mark.svg": "6236b91093b617a4415336c49da014a4354eaa7d045fd576c10fc7ad5ddd1f5e",
      "public/brand/digr-mark-white.svg": "1602720364792800740622d1eb3ab0464731447a818dfc539c31b67967683484",
      "public/brand/digr-app-icon.svg": "750aadfaf99a4de1dd8ed2892dd114796450975faa9b589fe000a36178eb6e11",
      "public/favicon.svg": "aa0405a915ed366fe76e3bc19cfedac99fe9b1e2dd5f323591ae977dbd293496",
    };
    for (const [path, hash] of Object.entries(expected)) expect(digest(path)).toBe(hash);
    expect(digest("src/app/icon.svg")).toBe(expected["public/favicon.svg"]);
    expect(read("src/components/BrandLogo.tsx")).toContain("/brand/digr-wordmark-white.svg");
    expect(read("src/components/BrandLogo.tsx")).toContain("/brand/digr-wordmark.svg");
    expect(read("src/app/layout.tsx")).toContain('icons: { icon: "/favicon.svg"');
  });

  it("keeps reduced-motion support enabled", () => {
    expect(read("src/app/globals.css")).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
