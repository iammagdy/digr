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

/** Keep only records whose provider publication/creation date is verifiably inside the requested window. */
export function filterRowsByDateRange<T>(
  input: T[],
  from?: string,
  to?: string,
  options: { keepUndated?: boolean } = {},
): DateRangeFilterResult<T> {
  if (!from && !to) return { rows: input, excludedCount: 0 };
  const start = from ? boundary(from, false) : Number.NEGATIVE_INFINITY;
  const end = to ? boundary(to, true) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(start) && start !== Number.NEGATIVE_INFINITY) return { rows: [], excludedCount: input.length };
  if (!Number.isFinite(end) && end !== Number.POSITIVE_INFINITY) return { rows: [], excludedCount: input.length };

  const rows = input.filter((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const timestamp = rowTimestamp(value as Record<string, unknown>);
    // A directory of people or companies has no publication date: a row without one is not outside the window.
    if (timestamp === null) return Boolean(options.keepUndated);
    return timestamp >= start && timestamp <= end;
  });
  return { rows, excludedCount: input.length - rows.length };
}

export type RowDateSummary = {
  /** Rows the filter drops because no publication date could be read. */
  missing: number;
  /** Rows with a readable date that falls outside the window. */
  outside: number;
  /** Oldest and newest readable date among ALL returned rows (YYYY-MM-DD, UTC), or null when none has one. */
  oldest: string | null;
  newest: string | null;
  /** Publish dates (YYYY-MM-DD, null = unreadable) of at most the first three rows: enough to prove a cause, never row content. */
  sampleDates: Array<string | null>;
};

const isoDay = (timestamp: number): string => new Date(timestamp).toISOString().slice(0, 10);

/** Why the date window dropped rows on one page, read with the same date rules as filterRowsByDateRange. Dates only, no row content. */
export function summarizeRowDates(input: unknown[], from?: string, to?: string): RowDateSummary {
  const start = from ? boundary(from, false) : Number.NEGATIVE_INFINITY;
  const end = to ? boundary(to, true) : Number.POSITIVE_INFINITY;
  const summary: RowDateSummary = { missing: 0, outside: 0, oldest: null, newest: null, sampleDates: [] };
  let oldest = Number.POSITIVE_INFINITY;
  let newest = Number.NEGATIVE_INFINITY;
  input.forEach((value, index) => {
    const row = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    const timestamp = row ? rowTimestamp(row) : null;
    if (index < 3) summary.sampleDates.push(timestamp === null ? null : isoDay(timestamp));
    if (timestamp === null) {
      summary.missing++;
      return;
    }
    if (timestamp < oldest) oldest = timestamp;
    if (timestamp > newest) newest = timestamp;
    if (!(timestamp >= start && timestamp <= end)) summary.outside++;
  });
  if (Number.isFinite(oldest)) summary.oldest = isoDay(oldest);
  if (Number.isFinite(newest)) summary.newest = isoDay(newest);
  return summary;
}
