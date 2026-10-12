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

/** «منذ ١٠ دقائق» style relative time, Arabic digits. */
export function timeAgoAr(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "الآن";
  const m = Math.round(s / 60);
  if (m < 60) return `منذ ${toArabicDigits(m)} ${m === 1 ? "دقيقة" : m === 2 ? "دقيقتين" : m <= 10 ? "دقائق" : "دقيقة"}`;
  const h = Math.round(m / 60);
  if (h < 24) return `منذ ${toArabicDigits(h)} ${h === 1 ? "ساعة" : h === 2 ? "ساعتين" : h <= 10 ? "ساعات" : "ساعة"}`;
  const d = Math.round(h / 24);
  if (d === 1) return "أمس";
  return new Date(iso).toLocaleDateString("ar-EG", { day: "numeric", month: "long" });
}
