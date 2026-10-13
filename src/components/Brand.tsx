/* Official Diger (ديجر) logos from /public/brand — never redrawn, recolored, or stretched.
   The default "color" variant renders both color and white files; CSS shows the one matching [data-theme].

   English logo (`lang="en"`) is ready for when the English version of Diger launches. Do not use it until then.
   When i18n is added, derive `lang` from the active locale. */

import { MARK_SRC, WORDMARKS, logoImages, logoWidth, type LogoLang, type LogoVariant } from "@/lib/brand";

export function Logo({
  variant = "color",
  height = 32,
  lang = "ar",
  className = "",
}: {
  variant?: LogoVariant;
  height?: number;
  lang?: LogoLang;
  className?: string;
}) {
  const { alt } = WORDMARKS[lang];
  const width = logoWidth(lang, height);
  return (
    <span className={`inline-flex items-center ${className}`} dir="ltr">
      {logoImages(lang, variant).map((img) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={img.variant} src={img.src} alt={alt} width={width} height={height} style={{ height, width: "auto" }} className={img.className} />
      ))}
    </span>
  );
}

/** The د + lens symbol alone — for avatars, loaders, and anything under 24px tall. */
export function LogoMark({ size = 32, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center ${className}`} dir="ltr">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={MARK_SRC.color} alt="ديجر" width={size} height={size} style={{ height: size, width: size }} className="block [[data-theme=dark]_&]:hidden" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={MARK_SRC.white} alt="ديجر" width={size} height={size} style={{ height: size, width: size }} className="hidden [[data-theme=dark]_&]:block" />
    </span>
  );
}
