import type { WorkLogLine } from "./workLog";
import { counterAr, counterOfStored } from "./counterWording";

/**
 * STAGE 2, THE LIVE SHEET: THE READ MODEL AND THE POLLING CONTRACT (docs/STAGE-2.md, FOUNDATION-PLAN PR 4). While a job runs, the customer watches the rows the file will hold: on a desktop
 * a sheet that looks like the file (the same sheets, the same headers in the same order), on a phone cards and a counter «X من N». The snapshot is BUILT BY THE WORKER from its item log with
 * the same layout code as the file (`agent/src/stage2/liveSnapshot.ts`), so at completion the rows watched ARE the rows of the file (tests/stage2-live-equality.test.ts). The screen reads it by
 * POLLING (the free Supabase plan has no Realtime): a small request every few seconds, answered «nothing changed» when the cursor is the same, or with one bounded window of rows.
 *
 * This file is shared by the site and the worker: types and pure functions only, no I/O. Gated by `DIGER_STAGE2_LIVE_SHEET` (flags.ts) in the wiring.
 */

/** One cell as the file holds it: text as written, a number as its digits, a date as its instant (ISO, UTC) with a Cairo display text, a link as its address. Empty: the file's empty cell. */
export type LiveCellKind = "text" | "number" | "date" | "link" | "empty";
export interface LiveCell {
  k: LiveCellKind;
  /** The value exactly as the file's cell reads (a date: its ISO instant). */
  v: string;
  /** A date's text for the screen, in Cairo time (the file's own format). */
  d?: string;
}
export interface LiveRow { id: string; parentId: string | null; cells: LiveCell[] }
export interface LiveSheet {
  stageKey: string;
  /** The sheet's name in the file. */
  nameAr: string;
  /** The file's headers, in order (the readable columns, then «المعرّف», then «معرّف الأصل» on a child sheet). */
  headers: string[];
  rows: LiveRow[];
}
export type LiveStatus = "running" | "done";
export interface LiveSnapshot {
  v: 1;
  missionId: string;
  /** Opaque; changes whenever anything the screen shows changes (the item log's sequence, the work log, the status). */
  cursor: string;
  status: LiveStatus;
  /** X: the items of the file so far (every delivered stage, before the replies are placed under their comments). */
  delivered: number;
  /** N: the promised number, by the file's own rule (`promisedTotalOf`); null when the plan promises none. */
  promised: number | null;
  /** «X من N» in Arabic-Indic numerals (the phone's counter). */
  counterAr: string;
  sheets: LiveSheet[];
  workLog: WorkLogLine[];
  builtAt: number;
}

/** THE POLLING CONTRACT. The screen waits `intervalMs` (with jitter) between requests, longer when nothing changes (up to `maxIntervalMs`), and stops after `done`. */
export const LIVE_SHEET_POLL = {
  intervalMs: 5_000,
  minIntervalMs: 3_000,
  maxIntervalMs: 30_000,
  backoffFactor: 1.5,
  jitterShare: 0.2,
  /** The most rows one answer carries (the screen asks for the next window by `offset`). */
  maxRowsPerResponse: 200,
  defaultRowsPerResponse: 50,
  /** A cell longer than this is cut in the answer (`cut: true` on the row); the file keeps it whole. */
  maxCellChars: 500,
  /** The most work-log lines one answer carries (the newest). */
  maxWorkLogLines: 20,
  /** The answer's size limit (bytes of JSON); a window that would pass it is shortened. */
  maxPayloadBytes: 262_144,
} as const;

export interface LivePollRequest { cursor: string | null; sheet: string | null; offset: number; limit: number }
export type LivePollResponse =
  | { changed: false; cursor: string; retryAfterMs: number }
  | {
      changed: true;
      cursor: string;
      status: LiveStatus;
      delivered: number;
      promised: number | null;
      counterAr: string;
      workLog: WorkLogLine[];
      sheets: Array<{ stageKey: string; nameAr: string; headers: string[]; total: number }>;
      window: { stageKey: string; offset: number; rows: Array<LiveRow & { cut?: true }> };
      /** The window was shortened to stay under the size limit. */
      truncated: boolean;
      retryAfterMs: number | null;
    }
  /** The flag is off, or no snapshot exists yet: the screen shows today's panel. */
  | { changed: false; cursor: null; retryAfterMs: number; empty: true };

const whole = (v: unknown, dflt: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,7}$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : dflt;
};

/** A poll's query (URL search parameters), clamped: an offset of 0 or more, a limit of 1 to `maxRowsPerResponse`. */
export function parsePollRequest(q: { get(name: string): string | null } | Record<string, string | undefined>): LivePollRequest {
  const get = (k: string): string | null => (typeof (q as { get?: unknown }).get === "function" ? (q as { get(name: string): string | null }).get(k) : ((q as Record<string, string | undefined>)[k] ?? null));
  const cursor = get("cursor");
  const sheet = get("sheet");
  const limit = Math.min(LIVE_SHEET_POLL.maxRowsPerResponse, Math.max(1, whole(get("limit"), LIVE_SHEET_POLL.defaultRowsPerResponse) || LIVE_SHEET_POLL.defaultRowsPerResponse));
  return { cursor: cursor && cursor.length <= 200 ? cursor : null, sheet: sheet && sheet.length <= 100 ? sheet : null, offset: whole(get("offset"), 0), limit };
}

/** The counter's words live in counterWording.ts (finding F-1: over-delivery is said in words); re-exported so the worker and the tests keep one import. */
export { counterAr };

const cutRow = (r: LiveRow): LiveRow & { cut?: true } => {
  let cut = false;
  const cells = r.cells.map((c) => {
    if (c.v.length <= LIVE_SHEET_POLL.maxCellChars) return c;
    cut = true;
    return { ...c, v: `${c.v.slice(0, LIVE_SHEET_POLL.maxCellChars)}…` };
  });
  return cut ? { ...r, cells, cut: true } : r;
};

/**
 * THE ANSWER TO ONE POLL. The same cursor: «nothing changed» (a few bytes). Otherwise the counter, the newest work-log lines, every sheet's name, headers and row total, and ONE window of
 * rows of the asked sheet (the first sheet when none is asked), cut to the size limit. Pure: the route reads the newest stored snapshot and returns this.
 */
export function pollResponse(snapshot: LiveSnapshot | null, req: LivePollRequest, delayMs: number = LIVE_SHEET_POLL.intervalMs): LivePollResponse {
  if (!snapshot) return { changed: false, cursor: null, retryAfterMs: LIVE_SHEET_POLL.maxIntervalMs, empty: true };
  if (req.cursor !== null && req.cursor === snapshot.cursor && req.offset === 0) return { changed: false, cursor: snapshot.cursor, retryAfterMs: snapshot.status === "done" ? LIVE_SHEET_POLL.maxIntervalMs : delayMs };
  const sheet = snapshot.sheets.find((s) => s.stageKey === req.sheet) ?? snapshot.sheets[0] ?? null;
  const base = {
    changed: true as const, cursor: snapshot.cursor, status: snapshot.status, delivered: snapshot.delivered, promised: snapshot.promised, counterAr: counterOfStored(snapshot),
    workLog: snapshot.workLog.slice(-LIVE_SHEET_POLL.maxWorkLogLines),
    sheets: snapshot.sheets.map((s) => ({ stageKey: s.stageKey, nameAr: s.nameAr, headers: s.headers, total: s.rows.length })),
    retryAfterMs: snapshot.status === "done" ? null : delayMs,
  };
  let rows = sheet ? sheet.rows.slice(req.offset, req.offset + req.limit).map(cutRow) : [];
  let truncated = false;
  const size = (r: typeof rows): number => new TextEncoder().encode(JSON.stringify({ ...base, window: { stageKey: sheet?.stageKey ?? "", offset: req.offset, rows: r }, truncated: true })).length;
  while (rows.length > 0 && size(rows) > LIVE_SHEET_POLL.maxPayloadBytes) { rows = rows.slice(0, Math.max(0, Math.floor(rows.length / 2))); truncated = true; }
  return { ...base, window: { stageKey: sheet?.stageKey ?? "", offset: req.offset, rows }, truncated };
}

/** The wait before the next poll: the base interval while things change, growing by `backoffFactor` while nothing does (to `maxIntervalMs`), with ±`jitterShare` jitter. `random` in [0,1). */
export function nextPollDelayMs(previousMs: number, changed: boolean, random: () => number = Math.random): number {
  const base = changed ? LIVE_SHEET_POLL.intervalMs : Math.min(LIVE_SHEET_POLL.maxIntervalMs, Math.max(LIVE_SHEET_POLL.intervalMs, Math.round(previousMs * LIVE_SHEET_POLL.backoffFactor)));
  const jitter = 1 + (random() * 2 - 1) * LIVE_SHEET_POLL.jitterShare;
  return Math.min(LIVE_SHEET_POLL.maxIntervalMs, Math.max(LIVE_SHEET_POLL.minIntervalMs, Math.round(base * jitter)));
}
