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
