import { formatAr } from "../arabicDigits";
import { countAr, itemNounOf, type ItemNoun } from "./itemNoun";

/**
 * THE LIVE TRACKER OF A MISSION, from its own events and its own stages (one rule for every mission type: posts, comments, videos, companies, employees, reviews, anything the agent can run).
 *
 * For each stage it follows the work in the order it happens: the source's pages read and the items found, the items checked (accepted and left out), the items saved toward the target, then the files. Every number comes
 * from the `counts` of the mission's events (never from their text), and every number only GROWS: a source that is read again from its first page (a new search of the same stage) adds to the earlier total instead of
 * resetting it, and an event that repeats an older number changes nothing. The remaining time is computed by code from the measured speed since the work began, smoothed, and shown only when the estimates agree with each other.
 * Pure: no clock of its own (the caller gives `now`), no network.
 */
export interface TrackerStageInput { n: number; titleAr: string; expectedRows: number; deliver: boolean; /** The share of the sampled items the plan expected to match (0 to 1), when the plan knows it. */ yieldShare?: number }
export interface TrackerEventInput { id: number; counts: Record<string, number> | null; created_at: string }

export interface StageTrack {
  n: number;
  titleAr: string;
  noun: ItemNoun;
  planned: number;
  /** Source pages read, over every read of this stage's source. */
  pagesRead: number;
  /** Items found in the source (before any check). */
  found: number;
  checked: number;
  accepted: number;
  excluded: number;
  /** Items waiting for a review the budget or a failure delayed (not delivered, not charged, asked again). */
  pending: number;
  /** Items saved in the customer's file. */
  saved: number;
  /** 0 to 1: reading counts up to 90%, saving the rest; never goes back. */
  ratio: number;
  state: "waiting" | "running" | "done";
}

export interface TrackerResult {
  stages: StageTrack[];
  /** 0 to 1 over the whole mission (stages weighted by their planned items). */
  ratio: number;
  /** Seconds left, or null when the estimates do not agree yet (hidden rather than jumping). */
  remainingSeconds: number | null;
}

const MIN_RATIO_FOR_ETA = 0.12;
const MIN_ELAPSED_MS = 40_000;
const STABLE_SPREAD = 0.5;
const SMOOTHING = 0.3;
/** With no event for this long the estimate is not shown (it would only count down to a wrong «less than a minute»). */
const QUIET_HIDE_MS = 90_000;
/** The shown time may rise by this share (and by at least RISE_MIN_SECONDS) only after RISE_AFTER_EVENTS events in a row said so. */
const RISE_TOLERANCE = 0.1;
const RISE_MIN_SECONDS = 15;
const RISE_AFTER_EVENTS = 3;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function trackMission(input: { stages: ReadonlyArray<TrackerStageInput>; events: ReadonlyArray<TrackerEventInput>; finished?: boolean; /** The items of each stage IN THE FILE the customer received (the settlement's own count): when the mission is finished this is the number shown, whatever the live events said on the way. */ finalSaved?: ReadonlyArray<number | undefined>; now: number }): TrackerResult {
  const stages: StageTrack[] = input.stages.map((s) => ({ n: s.n, titleAr: s.titleAr, noun: itemNounOf(s.titleAr), planned: Math.max(0, Math.floor(s.expectedRows)), pagesRead: 0, found: 0, checked: 0, accepted: 0, excluded: 0, pending: 0, saved: 0, ratio: 0, state: "waiting" }));
  const bases = stages.map(() => ({ pages: 0, found: 0, lastPages: 0, lastFound: 0 }));
  const yields = new Map(input.stages.map((s) => [s.n, s.yieldShare]));
  const events = [...input.events].sort((a, b) => a.id - b.id);
  const samples: Array<{ at: number; p: number }> = [];
  let startedAt: number | null = null;
  let peak = 0;

  const openIndex = (): number => { const i = stages.findIndex((s) => s.planned > 0 && s.saved < s.planned); return i === -1 ? Math.max(0, stages.length - 1) : i; };
  const stageRatio = (s: StageTrack): number => {
    if (s.planned <= 0) return 0;
    const seen = s.checked >= 40 && s.accepted > 0 ? Math.min(1, Math.max(0.05, s.accepted / s.checked)) : Math.min(1, Math.max(0.05, yields.get(s.n) ?? 1));
    const needRaw = s.planned / seen;
    return Math.min(1, Math.max(s.saved / s.planned, 0.9 * Math.min(1, s.found / needRaw)));
  };

  for (const e of events) {
    const c = e.counts ?? {};
    const at = Date.parse(e.created_at);
    const staged = num(c.stage) > 0 && typeof c.saved === "number";
    const collecting = !staged && typeof c.pages === "number" && typeof c.rows === "number";
    if (!staged && !collecting) continue;
    if (startedAt === null && Number.isFinite(at)) startedAt = at;
    if (staged) {
      const s = stages[Math.floor(num(c.stage)) - 1];
      if (s) {
        s.saved = Math.max(s.saved, Math.floor(num(c.saved)));
        if (typeof c.checked === "number") s.checked = Math.max(s.checked, Math.floor(c.checked));
        if (typeof c.accepted === "number") s.accepted = Math.max(s.accepted, Math.floor(c.accepted));
        if (typeof c.excluded === "number") s.excluded = Math.max(s.excluded, Math.floor(c.excluded));
        if (typeof c.pending === "number") s.pending = Math.max(0, Math.floor(c.pending));
      }
    } else {
      const i = openIndex();
      const s = stages[i];
      const b = bases[i];
      const pages = Math.floor(num(c.pages));
      const rows = Math.floor(num(c.rows));
      // a source read again from its first page: what the earlier read reached is added, not forgotten
      if (pages < b.lastPages || rows < b.lastFound) { b.pages += b.lastPages; b.found += b.lastFound; }
      b.lastPages = pages;
      b.lastFound = rows;
      s.pagesRead = Math.max(s.pagesRead, b.pages + pages);
      s.found = Math.max(s.found, b.found + rows);
    }
    for (const s of stages) s.ratio = Math.max(s.ratio, stageRatio(s));
    const total = stages.reduce((n, s) => n + s.planned, 0);
    const p = total > 0 ? stages.reduce((n, s) => n + s.planned * s.ratio, 0) / total : 0;
    peak = Math.max(peak, p);
    if (Number.isFinite(at)) samples.push({ at, p: peak });
  }

  for (const [i, s] of stages.entries()) {
    // the end: the number of the stage is the count of its items in the delivered file (never the last live number, which could be higher or lower)
    const final = input.finished ? input.finalSaved?.[i] : undefined;
    if (typeof final === "number" && Number.isFinite(final)) s.saved = Math.max(0, Math.floor(final));
    s.state = input.finished || (s.planned > 0 && s.saved >= s.planned) ? "done" : "waiting";
    if (input.finished) s.ratio = Math.max(s.ratio, 1);
  }
  if (!input.finished) { const open = stages.find((s) => s.state !== "done"); if (open && (open.found > 0 || open.saved > 0 || open.checked > 0 || stages.some((s) => s.state === "done"))) open.state = "running"; }
  const total = stages.reduce((n, s) => n + s.planned, 0);
  const ratio = input.finished ? 1 : Math.min(1, total > 0 ? stages.reduce((n, s) => n + s.planned * s.ratio, 0) / total : 0);

  return { stages, ratio, remainingSeconds: input.finished || startedAt === null ? null : remainingFrom(samples, startedAt, input.now) };
}

/**
 * The remaining time from the speed since the work began: at each event, elapsed x (1 - p) / p; the shown value follows the estimates smoothly (and counts down with the clock between events); it is hidden until
 * the last three estimates agree within half of their middle value, and when nothing has happened for a while.
 */
export function remainingFrom(samples: ReadonlyArray<{ at: number; p: number }>, startedAt: number, now: number): number | null {
  const raws: number[] = [];
  let shown: number | null = null;
  let lastAt = startedAt;
  let lastP = 0;
  let riseStreak = 0;
  for (const s of samples) {
    const elapsed = s.at - startedAt;
    if (shown !== null) shown = Math.max(0, shown - (s.at - lastAt) / 1000);
    lastAt = s.at;
    lastP = s.p;
    if (s.p < MIN_RATIO_FOR_ETA || elapsed < MIN_ELAPSED_MS) continue;
    const raw = (elapsed / 1000) * (1 - s.p) / s.p;
    raws.push(raw);
    if (shown === null) { shown = raw; continue; }
    const next = (1 - SMOOTHING) * shown + SMOOTHING * raw;
    // NEVER UP AND DOWN: the shown time follows the clock down and the estimates smoothly; it rises only when the estimates have said «longer» for several events in a row (one slow page does not make the time jump up)
    if (next > shown * (1 + RISE_TOLERANCE) && next - shown > RISE_MIN_SECONDS) { riseStreak += 1; if (riseStreak >= RISE_AFTER_EVENTS) { shown = next; riseStreak = 0; } }
    else { riseStreak = 0; shown = Math.min(next, shown * (1 + RISE_TOLERANCE)); }
  }
  if (shown === null || raws.length < 3) return null;
  const recent = raws.slice(-3);
  const mid = [...recent].sort((a, b) => a - b)[1];
  if (mid > 0 && (Math.max(...recent) - Math.min(...recent)) / mid > STABLE_SPREAD) return null;
  if (now - lastAt > QUIET_HIDE_MS) return null;
  const left = Math.max(0, shown - Math.max(0, now - lastAt) / 1000);
  // «less than a minute» is only said near the end; before that a tiny estimate is not trusted
  if (left < 30 && lastP < 0.95) return null;
  return left;
}

/** «نحو ٤ دقائق»: whole minutes, never «أقل من دقيقة» before the end. */
export function remainingLineAr(seconds: number | null, ratio: number): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return ratio >= 0.95 ? "المتبقي أقل من دقيقة" : null;
  if (minutes >= 60) { const h = Math.round(minutes / 60); return `المتبقي نحو ${h === 1 ? "ساعة" : h === 2 ? "ساعتين" : h <= 10 ? `${formatAr(h)} ساعات` : `${formatAr(h)} ساعة`}`; }
  return `المتبقي ${minutes === 1 ? "نحو دقيقة" : minutes === 2 ? "نحو دقيقتين" : minutes <= 10 ? `نحو ${formatAr(minutes)} دقائق` : `نحو ${formatAr(minutes)} دقيقة`}`;
}

/** The live numbers of one stage as short Arabic lines, in the order the work happens; a line appears when its number exists and never shows a number that went down. */
export function stageMetricLines(s: StageTrack): string[] {
  const lines: string[] = [];
  if (s.found > 0) lines.push(`وُجد ${countAr(s.found, s.noun)} في ${s.pagesRead === 1 ? "صفحة واحدة" : s.pagesRead === 2 ? "صفحتين" : s.pagesRead <= 10 ? `${formatAr(s.pagesRead)} صفحات` : `${formatAr(s.pagesRead)} صفحة`} من المصدر`);
  if (s.checked > 0) lines.push(`فُحص ${formatAr(s.checked)}: قُبل ${formatAr(s.accepted)}${s.excluded > 0 ? `، واستُبعد ${formatAr(s.excluded)}` : ""}`);
  if (s.pending > 0) lines.push(`بانتظار المراجعة ${formatAr(s.pending)}`);
  return lines;
}
