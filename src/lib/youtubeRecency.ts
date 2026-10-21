/**
 * YouTube's search returns the most relevant videos of all time, so a window such as «آخر شهر» is only reachable when the search
 * itself is told to prefer recent uploads. The upload-date filter and the sort-by-newest order are the two controls the source
 * (`tikhub.youtube.search.videos`) lists; the values below are the ones YouTube's own search filters use.
 * The worker's date filter stays behind this as a safety net.
 */

export type YoutubeRecency = {
  /** YouTube's upload-date bucket. Absent when the window has no start date (only the order is then sent). */
  upload_date?: "week" | "month" | "year";
  sort_by: "upload_date";
};

const DAY_MS = 86_400_000;
/** A bucket must reach back past the window's start; YouTube's own buckets are the last 7 days, 30 days and 365 days. */
const WEEK_REACH_DAYS = 5;
const MONTH_REACH_DAYS = 27;
const YEAR_REACH_DAYS = 360;

function dayStartMs(value: string | undefined | null): number | null {
  const match = /^\s*(\d{4}-\d{2}-\d{2})/.exec(String(value ?? ""));
  if (!match) return null;
  const parsed = Date.parse(`${match[1]}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The recency control for a window, or null when the source cannot express it (no window, or a window that starts more than a
 * year ago: YouTube has no bucket that reaches it, and sorting by newest would only walk through a year of newer videos).
 * A bucket wider than the window is harmless: the order is newest first and the date filter trims what is left.
 */
export function youtubeRecencyFor(dateFrom: string | undefined | null, dateTo: string | undefined | null, nowMs: number): YoutubeRecency | null {
  const from = dayStartMs(dateFrom);
  const to = dayStartMs(dateTo);
  if (from === null && to === null) return null;
  if (from === null) return { sort_by: "upload_date" };
  const daysBack = (nowMs - from) / DAY_MS;
  if (daysBack > YEAR_REACH_DAYS) return null;
  const upload_date = daysBack <= WEEK_REACH_DAYS ? "week" : daysBack <= MONTH_REACH_DAYS ? "month" : "year";
  return { upload_date, sort_by: "upload_date" };
}

/** A topic search shows a limited number of videos at a time: said in the plan of a large windowed request, before approval. */
export const YOUTUBE_RECENT_SUPPLY_FROM_VOLUME = 40;
export const YOUTUBE_RECENT_SUPPLY_NOTE_AR = "يعرض يوتيوب نحو ٢٠ فيديو في كل بحث، فإن قلّت الفيديوهات الحديثة عن موضوعك قد يقل عدد التعليقات المسلَّمة عن المطلوب، ولا يُحتسب عليك إلا ما سُلِّم؛ ولعدد أوفر أرسل روابط الفيديوهات أو اسم القناة.";

/** Said in the plan when the window starts too far back for the search to reach. */
export const YOUTUBE_OLD_WINDOW_NOTE_AR = "يتيح يوتيوب ترتيب نتائج البحث بالأحدث ضمن آخر سنة فقط، وقد لا نصل إلى فيديوهات هذه الفترة؛ ننصح بإرسال روابط الفيديوهات أو اسم القناة.";
