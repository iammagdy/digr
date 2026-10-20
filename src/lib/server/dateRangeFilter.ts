type DateRangeFilterResult<T> = {
  rows: T[];
  excludedCount: number;
};

const DATE_FIELDS = [
  "published_at",
  "publishedAt",
  "published_date",
  "create_time",
  "createTime",
  "created_at",
  "createdAt",
  "createdUtc",
  "created_utc",
  "timestamp",
  "date",
];

function parseRowDate(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  let timestamp = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  // Provider timestamps are commonly Unix seconds; JS dates use milliseconds.
  if (typeof value === "number" && Math.abs(timestamp) < 1e12) timestamp *= 1000;
  return timestamp;
}

function rowTimestamp(row: Record<string, unknown>): number | null {
  for (const field of DATE_FIELDS) {
    const timestamp = parseRowDate(row[field]);
    if (timestamp !== null) return timestamp;
  }
  return null;
}

function boundary(value: string, endOfDay: boolean): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return Number.NaN;
  // Date-only constraints are inclusive for the entire requested day.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return Date.parse(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  }
  return parsed;
}

/** Marks of a comment the source gave no date for: the window is applied to the date of its video (see markVideoDateBasis). */
export const DATE_BASIS_KEY = "_date_basis";
export const VIDEO_PUBLISHED_AT_KEY = "_video_published_at";

/** The date a row is judged by: its own, or the date of its video when the row carries the video-basis mark. */
export function windowDateMs(row: unknown): number | null {
  if (row && typeof row === "object" && (row as Record<string, unknown>)[DATE_BASIS_KEY] === "video") {
    const video = Number((row as Record<string, unknown>)[VIDEO_PUBLISHED_AT_KEY]);
    return Number.isFinite(video) ? video : null;
  }
  return rowDateMs(row);
}

export type RowDateVerdict = "inside" | "outside" | "missing";

const isoDay = (timestamp: number): string => new Date(timestamp).toISOString().slice(0, 10);

/** The readable publication/creation time of a row in ms (Unix seconds are converted), or null when it has none. */
export function rowDateMs(row: unknown): number | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  return rowTimestamp(row as Record<string, unknown>);
}

/**
 * THE one place that decides where a row stands against the window: the filter that removes rows and the diagnostic that
 * reports them both read this, so what is reported is exactly what was removed. `dateOf` lets a caller judge a row by
 * another date than its own (a comment whose source shows only the date of its video).
 */
export function classifyRowsByDate<T>(
  input: T[],
  from?: string,
  to?: string,
  dateOf: (row: T) => number | null = (row) => windowDateMs(row),
): { verdicts: RowDateVerdict[]; times: Array<number | null> } {
  const start = from ? boundary(from, false) : Number.NEGATIVE_INFINITY;
  const end = to ? boundary(to, true) : Number.POSITIVE_INFINITY;
  const unusableWindow = (!Number.isFinite(start) && start !== Number.NEGATIVE_INFINITY) || (!Number.isFinite(end) && end !== Number.POSITIVE_INFINITY);
  const times = input.map((row) => dateOf(row));
  const verdicts = times.map((time): RowDateVerdict => {
    if (time === null) return "missing";
    if (unusableWindow) return "outside";
    return time >= start && time <= end ? "inside" : "outside";
  });
  return { verdicts, times };
}

/** Keep only records whose provider publication/creation date is verifiably inside the requested window. */
export function filterRowsByDateRange<T>(
  input: T[],
  from?: string,
  to?: string,
  options: { keepUndated?: boolean } = {},
): DateRangeFilterResult<T> {
  if (!from && !to) return { rows: input, excludedCount: 0 };
  const { verdicts } = classifyRowsByDate(input, from, to);
  // A directory of people or companies has no publication date: a row without one is not outside the window.
  const rows = input.filter((_, index) => verdicts[index] === "inside" || (verdicts[index] === "missing" && Boolean(options.keepUndated)));
  return { rows, excludedCount: input.length - rows.length };
}

export type RowDateSummary = {
  /** Rows the filter drops because no publication date could be read. */
  missing: number;
  /** Rows with a readable date that falls outside the window. */
  outside: number;
  /** Rows with a readable date inside the window. */
  inside: number;
  /** Oldest and newest readable date among ALL returned rows (YYYY-MM-DD, UTC), or null when none has one. */
  oldest: string | null;
  newest: string | null;
  /** Publish dates (YYYY-MM-DD, null = unreadable) of at most the first three rows: enough to prove a cause, never row content. */
  sampleDates: Array<string | null>;
};

/** Why the date window dropped rows on one page, from the same classification the filter uses. Dates only, no row content. */
export function summarizeRowDates<T = unknown>(
  input: T[],
  from?: string,
  to?: string,
  dateOf?: (row: T) => number | null,
): RowDateSummary {
  const { verdicts, times } = classifyRowsByDate(input, from, to, dateOf);
  const summary: RowDateSummary = { missing: 0, outside: 0, inside: 0, oldest: null, newest: null, sampleDates: [] };
  let oldest = Number.POSITIVE_INFINITY;
  let newest = Number.NEGATIVE_INFINITY;
  verdicts.forEach((verdict, index) => {
    const time = times[index];
    if (index < 3) summary.sampleDates.push(time === null ? null : isoDay(time));
    summary[verdict]++;
    if (time !== null) {
      if (time < oldest) oldest = time;
      if (time > newest) newest = time;
    }
  });
  if (Number.isFinite(oldest)) summary.oldest = isoDay(oldest);
  if (Number.isFinite(newest)) summary.newest = isoDay(newest);
  return summary;
}
