import { formatTime } from "@/lib/honestDisplay";

/** «اليوم ١٢:٤٦» · «أمس ٩:١٨ م» · «٨ أكتوبر» */
export function dayLabel(iso: string): string {
  const d = new Date(iso), now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diff === 0) return `اليوم ${formatTime(iso)}`;
  if (diff === 1) return `أمس ${formatTime(iso)}`;
  return new Intl.DateTimeFormat("ar-EG-u-nu-arab", { day: "numeric", month: "long" }).format(d);
}
