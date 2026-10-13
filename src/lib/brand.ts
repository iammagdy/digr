/* Official Diger (ديجر) logo files in /public/brand. Render them via <Logo /> / <LogoMark /> in src/components/Brand.tsx. */

export type LogoVariant = "color" | "white" | "mono-black" | "mono-white";
export type LogoLang = "ar" | "en";

export const WORDMARKS = {
  ar: { file: "digr-wordmark", alt: "ديجر", aspect: 156 / 72 },
  en: { file: "diger-en-wordmark", alt: "Diger", aspect: 220 / 64 },
} as const;

export const MARK_SRC = { color: "/brand/digr-mark.svg", white: "/brand/digr-mark-white.svg" } as const;

export function logoSrc(lang: LogoLang, variant: LogoVariant) {
  return `/brand/${WORDMARKS[lang].file}${variant === "color" ? "" : `-${variant}`}.svg`;
}

/** Images to render for a variant. "color" ships both files so CSS can swap to white under [data-theme=dark]. */
export function logoImages(lang: LogoLang, variant: LogoVariant): { variant: LogoVariant; src: string; className: string }[] {
  if (variant !== "color") return [{ variant, src: logoSrc(lang, variant), className: "block" }];
  return [
    { variant: "color", src: logoSrc(lang, "color"), className: "block [[data-theme=dark]_&]:hidden" },
    { variant: "white", src: logoSrc(lang, "white"), className: "hidden [[data-theme=dark]_&]:block" },
  ];
}

export function logoWidth(lang: LogoLang, height: number) {
  return Math.round(height * WORDMARKS[lang].aspect);
}
