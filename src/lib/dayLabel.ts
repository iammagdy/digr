import { formatTime } from "@/lib/honestDisplay";

const cairoDayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Cairo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const cairoDayEpoch = (date: Date): number => {
  const parts = cairoDayFormatter.format(date).split("-").map(Number);
  return Date.UTC(parts[0], parts[1] - 1, parts[2]);
};

const cairoDateFormatter = new Intl.DateTimeFormat("ar-EG-u-nu-arab", {
  timeZone: "Africa/Cairo",
  day: "numeric",
  month: "long",
});

/** «اليوم ١٢:٤٦» · «أمس ٩:١٨ م» · «٨ أكتوبر» */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = Math.round((cairoDayEpoch(now) - cairoDayEpoch(d)) / 86400000);
  if (diff === 0) return `اليوم ${formatTime(iso, { timeZone: "Africa/Cairo" })}`;
  if (diff === 1) return `أمس ${formatTime(iso, { timeZone: "Africa/Cairo" })}`;
  return cairoDateFormatter.format(d);
}
