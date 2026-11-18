import { AGENT_STUCK_PLANNING_AFTER_MS } from "../agentMission/constants";
import { ADDON_MARKER_COLUMN, withoutAddonRows } from "../agentMission/addonMarker";
import { requestedRowsOf } from "../agentMission/customerView";

/**
 * THE OVERVIEW'S MISSION NUMBERS (DT-20261118-06 phase 1A). Pure: the route reads the rows, this file counts them (tested on fakes).
 * Every number reads the `missions` table: a customer request is inserted there only (customerActions.ts createCustomerMission). The old `jobs` table holds only the
 * money record of an approved mission, so it never sees a request that failed, waited or was refused before approval.
 */

export const OVERVIEW_RANGES = [7, 30, 90] as const;
export type OverviewRange = (typeof OVERVIEW_RANGES)[number];
export const parseOverviewRange = (raw: string | null | undefined): OverviewRange => OVERVIEW_RANGES.find((r) => String(r) === raw) ?? 30;

/** The worker holds a mission in these two (readQueue in customerActions.ts counts the same two as «running»). */
export const RUNNING_STATUSES = ["planning", "executing"] as const;
/** Ended after a worker took it: the base of the success rate. Cancelled and unserved requests are not failures of delivery. */
export const ENDED_STATUSES = ["completed", "failed"] as const;
/** A running status whose lease ran out this long ago has no live worker: «متوقفة» (the same limit openMissions.ts uses for a stuck plan). */
export const MISSION_STALLED_AFTER_MS = AGENT_STUCK_PLANNING_AFTER_MS;
export const FAILED_RECENT_MS = 24 * 60 * 60 * 1000;
/** The API serves at most this many rows per request: every read pages with `.range()` (a bigger `.limit()` is cut silently). */
export const OVERVIEW_PAGE_SIZE = 1000;
/** At most this many pages of the window; a full last page sets `truncated` (the card then says the numbers are a lower bound). */
export const OVERVIEW_PAGES = 5;
export const OVERVIEW_ROW_CAP = OVERVIEW_PAGE_SIZE * OVERVIEW_PAGES;
/**
 * Named columns only. The plan is read through its two JSON paths `requestedRowsOf` needs (`stages`, `quantity`), the form the repository already uses
 * (dashboard/requests `stages:plan_public->stages`), never the whole public plan.
 */
export const OVERVIEW_COLUMNS = `id,status,delivered_units,reserved_points,charged_points,stages:plan_public->stages,quantity:plan_public->quantity,lease_until,created_at,updated_at,${ADDON_MARKER_COLUMN}`;
/** The activity feed's request events: the newest missions, add-on rows removed. */
export const RECENT_MISSIONS = 8;
export const RECENT_COLUMNS = `id,status,created_at,delivered_units,user_id,${ADDON_MARKER_COLUMN}`;
const DAY_MS = 86_400_000;
/**
 * The JSON path of the add-on marker for a COUNT (no rows come back, so withoutAddonRows cannot run): `.is(ADDON_PLAN_PATH, null)` keeps the rows whose `plan` has no `addon` key.
 * A key present with a JSON null is not SQL NULL, so it is left out, like hasAddonMarker does (addonMarker.ts).
 */
export const ADDON_PLAN_PATH = "plan->addon";

export interface OverviewMissionRow {
  id: string;
  status: string;
  delivered_units?: number | null;
  reserved_points?: number | null;
  charged_points?: number | null;
  plan_public?: unknown;
  /** `plan_public->stages` and `plan_public->quantity`, as the route selects them */
  stages?: unknown;
  quantity?: unknown;
  lease_until?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface MissionOverview {
  range: OverviewRange;
  missions: {
    /** missions created in the range */
    total: number;
    /** completed + failed */
    ended: number;
    /** completed with at least one delivered item */
    succeeded: number;
    failed: number;
    /** succeeded / ended, in percent; null when nothing ended */
    successPct: number | null;
    /** the same rate in the period before (for the change arrow); null when nothing ended then */
    successPctPrev: number | null;
    /** Σ delivered items and Σ «المطلوب» (requestedRowsOf) over the ended missions that had a plan */
    delivered: number;
    requested: number;
    /** ended missions whose hold was released in full or in part (reserve above the charge: the rest is released, DIGER-TRUTH §5) and the points released */
    released: number;
    releasedPoints: number;
  };
  live: { running: number; stalled: number; stalledMinMinutes: number | null; failed24h: number };
  truncated: boolean;
}

/** One line of the overview's activity feed. */
export interface RecentMission { id: string; status: string; created_at: string; delivered_units: number | null; user_id: string | null }

/** The newest RECENT_MISSIONS ordinary requests (add-on rows removed), with only the five fields the feed shows. */
export function recentMissionsOf(rows: ReadonlyArray<Record<string, unknown>>): RecentMission[] {
  return withoutAddonRows(rows).slice(0, RECENT_MISSIONS).map((r) => ({
    id: String(r.id),
    status: String(r.status),
    created_at: String(r.created_at),
    delivered_units: typeof r.delivered_units === "number" ? r.delivered_units : null,
    user_id: typeof r.user_id === "string" ? r.user_id : null,
  }));
}

/** The plan as `requestedRowsOf` reads it: the whole public plan when a caller has it, else the two selected JSON paths. */
const planOf = (r: OverviewMissionRow): unknown => (r.plan_public !== undefined ? r.plan_public : r.stages != null || r.quantity != null ? { stages: r.stages, quantity: r.quantity } : null);

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const at = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
const isEnded = (r: OverviewMissionRow) => (ENDED_STATUSES as readonly string[]).includes(r.status);
const isSuccess = (r: OverviewMissionRow) => r.status === "completed" && num(r.delivered_units) >= 1;
const rate = (rows: OverviewMissionRow[]) => {
  const ended = rows.filter(isEnded);
  return ended.length ? Math.round((rows.filter(isSuccess).length / ended.length) * 1000) / 10 : null;
};

/**
 * `rows`: missions of the range (add-on rows already removed); `liveRows`: every mission in a running status, whatever its age.
 * `previous`: the ended and succeeded counts of the period before (head counts the route makes, no rows); without it the previous rate is worked out from any older rows given.
 */
export function summarizeMissions(input: { rows: OverviewMissionRow[]; liveRows: OverviewMissionRow[]; range: OverviewRange; now: number; truncated: boolean; previous?: { ended: number | null; succeeded: number | null } | null }): MissionOverview {
  const { range, now } = input;
  const start = now - range * DAY_MS;
  const current = input.rows.filter((r) => at(r.created_at) >= start);
  const previous = input.rows.filter((r) => at(r.created_at) < start && at(r.created_at) >= start - range * DAY_MS);
  const ended = current.filter(isEnded);

  let delivered = 0, requested = 0, released = 0, releasedPoints = 0;
  for (const r of ended) {
    const asked = requestedRowsOf(planOf(r));
    if (asked > 0) { requested += asked; delivered += num(r.delivered_units); }
    const hold = num(r.reserved_points);
    const charged = num(r.charged_points);
    if (hold > 0 && charged < hold) { released += 1; releasedPoints += hold - charged; }
  }

  let running = 0, stalled = 0;
  let stalledMin: number | null = null;
  for (const r of input.liveRows) {
    if (!(RUNNING_STATUSES as readonly string[]).includes(r.status)) continue;
    const lease = at(r.lease_until);
    if (!Number.isFinite(lease)) continue;
    if (lease > now) { running += 1; continue; }
    if (lease < now - MISSION_STALLED_AFTER_MS) {
      stalled += 1;
      const idle = Math.floor((now - lease) / 60_000);
      stalledMin = stalledMin === null ? idle : Math.min(stalledMin, idle);
    }
  }

  return {
    range,
    missions: {
      total: current.length,
      ended: ended.length,
      succeeded: current.filter(isSuccess).length,
      failed: current.filter((r) => r.status === "failed").length,
      successPct: rate(current),
      successPctPrev: input.previous ? (input.previous.ended && input.previous.succeeded !== null ? Math.round((input.previous.succeeded / input.previous.ended) * 1000) / 10 : null) : rate(previous),
      delivered,
      requested,
      released,
      releasedPoints,
    },
    live: { running, stalled, stalledMinMinutes: stalledMin, failed24h: current.filter((r) => r.status === "failed" && at(r.updated_at) >= now - FAILED_RECENT_MS).length },
    truncated: input.truncated,
  };
}
