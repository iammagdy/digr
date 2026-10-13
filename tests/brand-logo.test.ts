import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MARK_SRC, WORDMARKS, logoImages, logoWidth, type LogoVariant } from "../src/lib/brand";

const ROOT = join(__dirname, "..");
const VARIANTS: LogoVariant[] = ["color", "white", "mono-black", "mono-white"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(tsx?|jsx?)$/.test(name) ? [full] : [];
  });
}

describe("brand logo", () => {
  it("defaults to the Arabic color wordmark with a dark-mode white swap", () => {
    expect(logoImages("ar", "color").map((i) => i.src)).toEqual(["/brand/diger-wordmark.svg", "/brand/diger-wordmark-white.svg"]);
    expect(WORDMARKS.ar.alt).toBe("ديجر");
    expect(readFileSync(join(ROOT, "src/components/Brand.tsx"), "utf-8")).toMatch(/lang = "ar"/);
  });

  it("resolves the English wordmark for when the English UI launches", () => {
    expect(logoImages("en", "mono-black")).toEqual([{ variant: "mono-black", src: "/brand/diger-en-wordmark-mono-black.svg", className: "block" }]);
    expect(WORDMARKS.en.alt).toBe("Diger");
    expect(logoWidth("en", 64)).toBe(220);
    expect(logoWidth("ar", 72)).toBe(156);
  });

  it("points every variant at a file that exists in public/brand", () => {
    const srcs = [
      ...(["ar", "en"] as const).flatMap((lang) => VARIANTS.flatMap((v) => logoImages(lang, v).map((i) => i.src))),
      ...Object.values(MARK_SRC),
    ];
    for (const src of srcs) expect(existsSync(join(ROOT, "public", src)), src).toBe(true);
  });

  it("does not render the English logo anywhere in the UI yet", () => {
    const offenders = sourceFiles(join(ROOT, "src")).filter((f) => {
      const code = readFileSync(f, "utf-8");
      return /<Logo\b[^>]*\blang=\{?["']en["']/.test(code) || code.includes("/brand/diger-en-");
    });
    expect(offenders).toEqual([]);
  });

  it("ships one favicon, touch icon and manifest set", () => {
    for (const file of ["favicon.ico", "favicon.svg", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "site.webmanifest"]) {
      expect(existsSync(join(ROOT, "public", file)), file).toBe(true);
    }
    const manifest = JSON.parse(readFileSync(join(ROOT, "public", "site.webmanifest"), "utf-8"));
    for (const icon of manifest.icons) expect(existsSync(join(ROOT, "public", icon.src)), icon.src).toBe(true);
    // app/icon.svg would override metadata.icons with a second, conflicting <link rel="icon">.
    expect(existsSync(join(ROOT, "src", "app", "icon.svg"))).toBe(false);
  });
});
