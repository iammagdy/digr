import { formatAr, toArabicDigits } from "@/lib/arabicDigits";

export const EGP = (n: number) => `${formatAr(Math.round(n))} ج.م`;
export const initials = (name: string) => {
  const a = (name || "").trim().split(/\s+/);
  return [a[0]?.[0], a[1]?.[0]].filter(Boolean).join(" ") || "؟";
};
/** «١١/١٠/٢٠٢٦، ٩:٤٢ ص» — day/month/year, always read left-to-right like the design. */
export function dateTimeAr(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${`\u2066${toArabicDigits(`${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`)}\u2069`}، ${new Intl.DateTimeFormat("ar-EG-u-nu-arab", { hour: "numeric", minute: "2-digit" }).format(d)}`;
}
/** «منذ ٤ دقائق» … «منذ شهر» */
export function agoAr(iso?: string | null, now = Date.now()): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  const u = (n: number, one: string, two: string, few: string, many: string) => (n === 1 ? one : n === 2 ? two : `${toArabicDigits(n)} ${n <= 10 ? few : many}`);
  if (s < 60) return "الآن";
  const m = Math.round(s / 60);
  if (m < 60) return `منذ ${m === 1 ? "دقيقة" : m === 2 ? "دقيقتين" : `${toArabicDigits(m)} ${m <= 10 ? "دقائق" : "دقيقة"}`}`;
  const h = Math.round(m / 60);
  if (h < 24) return `منذ ${h === 1 ? "ساعة" : h === 2 ? "ساعتين" : `${toArabicDigits(h)} ${h <= 10 ? "ساعات" : "ساعة"}`}`;
  const d = Math.round(h / 24);
  if (d === 1) return "أمس";
  if (d < 7) return `منذ ${d === 2 ? "يومين" : `${toArabicDigits(d)} ${d <= 10 ? "أيام" : "يومًا"}`}`;
  const w = Math.round(d / 7);
  if (d < 30) return `منذ ${w === 1 ? "أسبوع" : w === 2 ? "أسبوعين" : `${toArabicDigits(w)} أسابيع`}`;
  const mo = Math.round(d / 30);
  void u;
  return `منذ ${mo === 1 ? "شهر" : mo === 2 ? "شهرين" : `${toArabicDigits(mo)} ${mo <= 10 ? "أشهر" : "شهرًا"}`}`;
}
export function badgeFor(status: string): { bg: string; fg: string; label: string } {
  if (status === "approved") return { bg: "color-mix(in oklab, var(--ok) 14%, transparent)", fg: "var(--ok)", label: "معتمد" };
  if (status === "rejected") return { bg: "color-mix(in oklab, var(--bad) 14%, transparent)", fg: "var(--bad)", label: "مرفوض" };
  return { bg: "color-mix(in oklab, var(--gold) 16%, transparent)", fg: "var(--goldT)", label: "قيد المراجعة" };
}
export const tint = (color: string, pct: number) => `color-mix(in oklab, ${color} ${pct}%, transparent)`;

/** Compact audit stamp «٦/١٠ · ٥:١٢ م» (day/month, no year). */
export function shortStampAr(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const time = new Intl.DateTimeFormat("ar-EG-u-nu-arab", { hour: "numeric", minute: "2-digit" }).format(d);
  return `\u2066${toArabicDigits(`${d.getDate()}/${d.getMonth() + 1}`)}\u2069 · ${time}`;
}
