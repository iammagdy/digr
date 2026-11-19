/**
 * The numbers of the admin «الزوّار» tab, worked out from the stored visit rows. Pure (rows in, numbers out), so the arithmetic is tested without a database.
 * Definitions, kept in one place so the screen and the tests say the same thing:
 *  - visit: one session (one browser tab's run) that viewed at least one page; page view: one «view» row;
 *  - unique visitor: one anonymous visitor id with at least one view;
 *  - time on a visit: the sum of the seconds of the session's «leave» rows (the time the page was in front of the visitor), averaged over the visits that have any;
 *  - logins / sign-ups: the «login» / «signup» rows the sign-in and sign-up forms reported;
 *  - funnel: visitors who viewed a page -> of them, those who signed up -> of them, those whose account (linked at their login) has a submitted request.
 */
/** «14d»: the overview's 14-day visits chart (Cairo midnight 13 days before today). */
export type VisitRange = "today" | "7d" | "14d" | "all";
export const VISIT_RANGES: readonly VisitRange[] = ["today", "7d", "14d", "all"];
/** How many Cairo days `daily` holds (the overview chart). */
export const DAILY_DAYS = 14;
/** The most rows one summary reads; a bigger range says so instead of pretending to be complete. */
export const SUMMARY_ROW_LIMIT = 20_000;
const MAX_VISIT_SECONDS = 4 * 3600;

export interface VisitEventRow {
  visitor_id: string;
  session_id: string;
  kind: "view" | "leave" | "login" | "signup";
  path: string;
  country: string | null;
  device_class: "mobile" | "tablet" | "desktop";
  started_at: string;
  duration_seconds: number | null;
  user_id: string | null;
}

export interface VisitorSummary {
  range: VisitRange;
  since: string | null;
  truncated: boolean;
  visits: number;
  pageViews: number;
  uniqueVisitors: number;
  logins: { events: number; users: number };
  signups: { events: number };
  avgVisitSeconds: number | null;
  topPages: Array<{ path: string; views: number; visitors: number }>;
  devices: { mobile: number; desktop: number; tablet: number };
  countries: Array<{ code: string | null; visits: number }>;
  funnel: { visited: number; signedUp: number; requested: number };
  /** The last DAILY_DAYS Cairo days, oldest first, every day present (0 when nothing happened). A visit counts on the Cairo day of its first view; a unique visitor on every Cairo day with one of their views. */
  daily: Array<{ day: string; visits: number; uniqueVisitors: number }>;
}

/** The start of «today» in Cairo (the owner's day), and of the last seven days; null for «all». */
export function rangeStart(range: VisitRange, now: Date = new Date()): Date | null {
  if (range === "all") return null;
  if (range === "7d") return new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  if (range === "14d") return rangeStart("today", new Date(now.getTime() - (DAILY_DAYS - 1) * 24 * 3600 * 1000));
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const localAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const offset = localAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day")) - offset);
}

const CAIRO_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" });
/** «2026-11-18»: the Cairo calendar day of an instant. */
export const cairoDay = (date: Date): string => CAIRO_DAY.format(date);

/** The last `days` Cairo days ending today, oldest first. */
export function lastCairoDays(now: Date, days: number = DAILY_DAYS): string[] {
  const [y, m, d] = cairoDay(now).split("-").map(Number);
  return Array.from({ length: days }, (_, i) => new Date(Date.UTC(y, m - 1, d - (days - 1 - i))).toISOString().slice(0, 10));
}

export const parseRange = (value: unknown): VisitRange => (VISIT_RANGES as readonly string[]).includes(String(value)) ? (String(value) as VisitRange) : "today";

export function summarizeVisits(
  rows: ReadonlyArray<VisitEventRow>,
  options: { range: VisitRange; since: Date | null; truncated?: boolean; firstRequestByUser?: ReadonlyMap<string, string>; now?: Date },
): VisitorSummary {
  const views = rows.filter((row) => row.kind === "view");
  const sessions = new Map<string, { device: VisitEventRow["device_class"]; country: string | null; seconds: number; hasLeave: boolean; day: string }>();
  const dayBuckets = new Map(lastCairoDays(options.now ?? new Date()).map((day) => [day, { visits: 0, visitors: new Set<string>() }]));
  const visitors = new Set<string>();
  const pages = new Map<string, { views: number; visitors: Set<string> }>();
  // views arrive newest first or in any order: the FIRST view of a session decides its device and country
  const ordered = [...views].sort((a, b) => a.started_at.localeCompare(b.started_at));
  for (const view of ordered) {
    visitors.add(view.visitor_id);
    const at = new Date(view.started_at);
    const day = Number.isFinite(at.getTime()) ? cairoDay(at) : "";
    if (!sessions.has(view.session_id)) {
      sessions.set(view.session_id, { device: view.device_class, country: view.country, seconds: 0, hasLeave: false, day });
      const bucket = dayBuckets.get(day);
      if (bucket) bucket.visits += 1;
    }
    dayBuckets.get(day)?.visitors.add(view.visitor_id);
    const page = pages.get(view.path) ?? { views: 0, visitors: new Set<string>() };
    page.views += 1;
    page.visitors.add(view.visitor_id);
    pages.set(view.path, page);
  }
  for (const row of rows) {
    if (row.kind !== "leave") continue;
    const session = sessions.get(row.session_id);
    if (!session) continue;
    session.seconds += Math.max(0, Math.floor(Number(row.duration_seconds) || 0));
    session.hasLeave = true;
  }
  const timed = [...sessions.values()].filter((session) => session.hasLeave);
  const avgVisitSeconds = timed.length ? Math.round(timed.reduce((sum, session) => sum + Math.min(session.seconds, MAX_VISIT_SECONDS), 0) / timed.length) : null;

  const devices = { mobile: 0, desktop: 0, tablet: 0 };
  const countryCounts = new Map<string | null, number>();
  for (const session of sessions.values()) {
    devices[session.device] += 1;
    countryCounts.set(session.country, (countryCounts.get(session.country) ?? 0) + 1);
  }

  const logins = rows.filter((row) => row.kind === "login");
  const signups = rows.filter((row) => row.kind === "signup");
  // Funnel: nested on purpose (each step is a part of the one before it).
  const signedUpVisitors = new Set(signups.map((row) => row.visitor_id).filter((id) => visitors.has(id)));
  const userOfVisitor = new Map<string, Set<string>>();
  for (const row of logins) {
    if (!row.user_id) continue;
    const set = userOfVisitor.get(row.visitor_id) ?? new Set<string>();
    set.add(row.user_id);
    userOfVisitor.set(row.visitor_id, set);
  }
  const firstRequest = options.firstRequestByUser ?? new Map<string, string>();
  let requested = 0;
  for (const visitor of signedUpVisitors) {
    if ([...(userOfVisitor.get(visitor) ?? [])].some((user) => firstRequest.has(user))) requested += 1;
  }

  return {
    range: options.range,
    since: options.since ? options.since.toISOString() : null,
    truncated: Boolean(options.truncated),
    visits: sessions.size,
    pageViews: views.length,
    uniqueVisitors: visitors.size,
    logins: { events: logins.length, users: new Set(logins.map((row) => row.user_id).filter(Boolean)).size },
    signups: { events: signups.length },
    avgVisitSeconds,
    topPages: [...pages.entries()].map(([path, page]) => ({ path, views: page.views, visitors: page.visitors.size })).sort((a, b) => b.views - a.views || a.path.localeCompare(b.path)).slice(0, 10),
    devices,
    countries: [...countryCounts.entries()].map(([code, visits]) => ({ code, visits })).sort((a, b) => b.visits - a.visits || String(a.code).localeCompare(String(b.code))).slice(0, 10),
    funnel: { visited: visitors.size, signedUp: signedUpVisitors.size, requested },
    daily: [...dayBuckets.entries()].map(([day, bucket]) => ({ day, visits: bucket.visits, uniqueVisitors: bucket.visitors.size })),
  };
}

/** The name of a country in Arabic from its two-letter code; the code itself when the runtime has no name for it. */
export function countryNameAr(code: string | null): string {
  if (!code) return "غير معروفة";
  try {
    return new Intl.DisplayNames(["ar"], { type: "region" }).of(code) || code;
  } catch {
    return code;
  }
}

export const DEVICE_LABEL_AR = { mobile: "جوال", desktop: "حاسوب", tablet: "جهاز لوحي" } as const;
