import { platformInitial, sectorHue } from "@/lib/servicesCatalogView";

/** A platform's tile: its first Arabic letter on a tint of its sector's colour. No logo files; the tint follows the light or dark theme. */
export function PlatformTile({ nameAr, sectorId, size = "md" }: { nameAr: string; sectorId: string; size?: "md" | "lg" }) {
  const hue = sectorHue(sectorId);
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-[14px] font-display font-medium ${size === "lg" ? "h-16 w-16 text-[34px]" : "h-11 w-11 text-[24px]"}`}
      style={{
        background: `color-mix(in oklab, hsl(${hue} 55% 50%) 16%, var(--sf))`,
        color: `color-mix(in oklab, hsl(${hue} 60% 40%) 78%, var(--ink))`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, hsl(${hue} 55% 50%) 22%, transparent)`,
      }}
    >
      {platformInitial(nameAr)}
    </span>
  );
}
