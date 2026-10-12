/** Arabic-Indic (٠-٩) and Persian (۰-۹) digits → ASCII. Used for every numeric field, client and server. */
export function normalizeDigits(input: string): string {
  return input
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** ASCII digits → Arabic-Indic, locale-independent (same output on server and client). */
export function toArabicDigits(input: string | number): string {
  return String(input).replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));
}

/** 1000 → ١٬٠٠٠ ; 12.5 → ١٢٫٥ */
export function formatAr(n: number, fractionDigits?: number): string {
  const fixed = fractionDigits === undefined ? String(n) : n.toFixed(fractionDigits);
  const [int, frac] = fixed.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, "٬");
  return toArabicDigits(frac ? `${grouped}٫${frac}` : grouped);
}
